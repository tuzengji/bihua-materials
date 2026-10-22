import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { normalizeMaterial, filterMaterials, signature, ValidationError } from '../public/shared.js';
import { seedMaterials } from './seeds.mjs';

export class StoreError extends Error {
  constructor(message, status = 400, details) { super(message); this.status = status; this.details = details; }
}

export function createStore(filename, { seed = true } = {}) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS materials (
      id TEXT PRIMARY KEY, text TEXT NOT NULL, type TEXT NOT NULL,
      difficulty TEXT NOT NULL, tags TEXT NOT NULL, notes TEXT NOT NULL,
      source TEXT NOT NULL, is_classic INTEGER NOT NULL DEFAULT 0,
      is_demo INTEGER NOT NULL DEFAULT 0, signature TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS deletion_audit (
      id INTEGER PRIMARY KEY, material_id TEXT NOT NULL, material_text TEXT NOT NULL,
      material_type TEXT NOT NULL, actor_name TEXT NOT NULL, deleted_at TEXT NOT NULL
    );
  `);
  const insert = db.prepare('INSERT INTO materials VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const select = db.prepare('SELECT * FROM materials WHERE id = ?');
  const fromRow = row => row ? ({
    id: row.id, text: row.text, type: row.type, difficulty: row.difficulty,
    tags: JSON.parse(row.tags), notes: row.notes, source: row.source,
    isClassic: Boolean(row.is_classic), isDemo: Boolean(row.is_demo),
    createdAt: row.created_at, updatedAt: row.updated_at,
  }) : null;
  const add = value => {
    const item = normalizeMaterial(value);
    if (db.prepare('SELECT id FROM materials WHERE signature = ?').get(signature(item))) throw new StoreError('同类型中已有这条素材', 409);
    const id = randomUUID(), now = new Date().toISOString();
    insert.run(id, item.text, item.type, item.difficulty, JSON.stringify(item.tags), item.notes, item.source, +item.isClassic, +item.isDemo, signature(item), now, now);
    return fromRow(select.get(id));
  };
  const list = (filters = {}) => filterMaterials(db.prepare('SELECT * FROM materials ORDER BY created_at DESC, rowid ASC').all().map(fromRow), filters);
  const previewImport = items => {
    if (!Array.isArray(items) || !items.length) throw new StoreError('请先提供需要导入的素材');
    if (items.length > 5000) throw new StoreError('一次最多导入 5000 条素材');
    const seen = new Set(db.prepare('SELECT signature FROM materials').all().map(row => row.signature));
    const normalized = [];
    const rows = items.map((input, index) => {
      const row = Number.isInteger(input?.row) && input.row > 0 ? input.row : index + 1;
      const text = typeof input?.text === 'string' ? input.text : '';
      try {
        if (input?.importError) throw new ValidationError(String(input.importError));
        const item = normalizeMaterial(input), key = signature(item);
        if (seen.has(key)) return { row, text, type: item.type, status: 'duplicate', message: '重复，导入时跳过' };
        seen.add(key); normalized.push(item);
        return { row, text, type: item.type, status: 'new', message: '可导入' };
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        return { row, text, status: 'error', message: error.message };
      }
    });
    const invalid = rows.filter(row => row.status === 'error').length;
    const duplicates = rows.filter(row => row.status === 'duplicate').length;
    return { normalized, total: rows.length, added: normalized.length, invalid, duplicates, rows };
  };
  if (!db.prepare("SELECT value FROM metadata WHERE key = 'initialized'").get()) {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (seed) {
        for (const material of seedMaterials) add(material);
        const initializedAt = new Date().toISOString();
        db.prepare('UPDATE materials SET created_at = ?, updated_at = ?').run(initializedAt, initializedAt);
      }
      db.prepare('INSERT INTO metadata VALUES (?, ?)').run('initialized', '1');
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  }
  return {
    list, add,
    get(id) { const item = fromRow(select.get(id)); if (!item) throw new StoreError('这条素材已被删除', 404); return item; },
    update(id, patch) {
      const old = this.get(id);
      if (patch.updatedAt && patch.updatedAt !== old.updatedAt) throw new StoreError('这条素材刚被其他成员修改，请重新打开后编辑', 409);
      const item = normalizeMaterial({ ...old, ...patch });
      const duplicate = db.prepare('SELECT id FROM materials WHERE signature = ? AND id != ?').get(signature(item), id);
      if (duplicate) throw new StoreError('同类型中已有这条素材', 409);
      const now = new Date(Math.max(Date.now(), Date.parse(old.updatedAt) + 1)).toISOString();
      db.prepare('UPDATE materials SET text=?, type=?, difficulty=?, tags=?, notes=?, source=?, is_classic=?, is_demo=?, signature=?, updated_at=? WHERE id=?')
        .run(item.text, item.type, item.difficulty, JSON.stringify(item.tags), item.notes, item.source, +item.isClassic, +item.isDemo, signature(item), now, id);
      return fromRow(select.get(id));
    },
    remove(id, options = {}) { this.get(id); this.removeMany([id], options); },
    removeMany(ids, { actor } = {}) {
      if (!Array.isArray(ids) || !ids.length) throw new StoreError('请先选择需要删除的素材');
      if (ids.length > 5000) throw new StoreError('一次最多删除 5000 条素材');
      if (ids.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(id))) throw new StoreError('所选素材编号格式不正确');
      const uniqueIds = [...new Set(ids)], remove = db.prepare('DELETE FROM materials WHERE id = ?');
      const audit = db.prepare('INSERT INTO deletion_audit (material_id, material_text, material_type, actor_name, deleted_at) VALUES (?, ?, ?, ?, ?)');
      let deleted = 0;
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const id of uniqueIds) {
          const item = fromRow(select.get(id));
          const changes = Number(remove.run(id).changes); deleted += changes;
          if (changes && actor) audit.run(id, item.text, item.type, actor, new Date().toISOString());
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return { deleted, alreadyDeleted: uniqueIds.length - deleted };
    },
    import(items, { preview = false } = {}) {
      const result = previewImport(items);
      const { normalized, ...report } = result;
      if (preview) return report;
      if (report.invalid) throw new StoreError('请修正错误行后再导入，本次没有写入素材', 422, report);
      db.exec('BEGIN IMMEDIATE');
      try { for (const material of normalized) add(material); db.exec('COMMIT'); }
      catch (error) { db.exec('ROLLBACK'); throw error; }
      return report;
    },
    close() { db.close(); },
  };
}
