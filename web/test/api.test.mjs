import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { parseMaterialCSV } from '../public/shared.js';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../lib/store.mjs';
import { createPasswordRecord, createDeleteVerifier } from '../lib/admin.mjs';

const TEST_PASSWORD = 'isolated-test-password';
const TEST_RECORD = createPasswordRecord(TEST_PASSWORD);
const TEST_AUTH = { name: '测试管理员', password: TEST_PASSWORD };

async function start(dbPath, seed = false, adminPasswordRecord = TEST_RECORD) {
  const app = createApp({ dbPath, seed, adminPasswordRecord });
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (path, method = 'GET', body, headers = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const data = response.status === 204 ? null : response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text();
    return { status: response.status, data, headers: response.headers };
  };
  const remove = (path, body = {}, headers) => request(path, 'DELETE', { ...body, auth: TEST_AUTH }, headers);
  return { ...app, request, remove, close: () => new Promise((resolve, reject) => { app.server.close(error => error ? reject(error) : resolve()); app.server.closeIdleConnections(); }) };
}

test('批量删除限定所选 ID，校验整批参数，兼容已删除项并持久保留结果', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bihua-bulk-delete-'));
  const filename = join(directory, 'materials.sqlite');
  let app = await start(filename);
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const first = app.store.add({ text: '待删词语', type: 'general' });
  const second = app.store.add({ text: '待删歌词', type: 'lyrics' });
  const keep = app.store.add({ text: '保留的句子', type: 'sentence' });
  for (const body of [{}, { ids: [] }, { ids: first.id }, { ids: [first.id, null] }, { ids: [first.id, '错误 ID'] }, { ids: Array(5001).fill(first.id) }]) {
    assert.equal((await app.remove('/api/materials', body)).status, 400);
    assert.equal(app.store.list().length, 3);
  }
  assert.equal((await app.request('/api/materials', 'DELETE')).status, 415);
  assert.equal((await app.remove('/api/materials', { ids: [first.id] }, { Origin: 'https://example.com' })).status, 403);
  assert.equal(app.store.list().length, 3);
  const deleted = await app.remove('/api/materials', { ids: [first.id, second.id, first.id, 'already-deleted-id'] });
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.data, { deleted: 2, alreadyDeleted: 1 });
  assert.deepEqual(app.store.list(), [keep]);
  assert.deepEqual((await app.remove('/api/materials', { ids: [first.id, second.id] })).data, { deleted: 0, alreadyDeleted: 2 });
  await app.close(); app = await start(filename, true);
  assert.deepEqual(app.store.list(), [keep]);
  assert.equal((await app.request('/api/materials/' + first.id)).status, 404);
});

test('批量删除遇到数据库错误时整批回滚，失败后仍可再次操作', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bihua-delete-rollback-'));
  const filename = join(directory, 'materials.sqlite');
  const store = createStore(filename, { seed: false }), control = new DatabaseSync(filename);
  t.after(async () => { control.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const first = store.add({ text: '回滚验证一', type: 'general' });
  const second = store.add({ text: '回滚验证二', type: 'general' });
  control.exec(`CREATE TRIGGER reject_delete BEFORE DELETE ON materials WHEN OLD.id = '${second.id}' BEGIN SELECT RAISE(ABORT, '模拟删除失败'); END;`);
  assert.throws(() => store.removeMany([first.id, second.id], { actor: '回滚测试' }), /模拟删除失败/);
  assert.equal(control.prepare('SELECT COUNT(*) AS count FROM deletion_audit').get().count, 0);
  assert.deepEqual(new Set(store.list().map(item => item.id)), new Set([first.id, second.id]));
  control.exec('DROP TRIGGER reject_delete');
  assert.deepEqual(store.removeMany([first.id, second.id], { actor: '回滚测试' }), { deleted: 2, alreadyDeleted: 0 });
  assert.equal(control.prepare('SELECT COUNT(*) AS count FROM deletion_audit').get().count, 2);
  assert.deepEqual(store.list(), []);
});

test('共享素材 API：录入、筛选、修改、导入、导出与持久化', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bihua-api-'));
  const filename = join(directory, 'materials.sqlite');
  let app = await start(filename);
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  let cat, poem;
  await t.test('不同客户端读到同一份素材；保留中文与换行', async () => {
    const first = await app.request('/api/materials', 'POST', { text: '猫', type: 'general', tags: ['动物'] });
    assert.equal(first.status, 201); cat = first.data.item;
    const second = await app.request('/api/materials', 'POST', { text: '床前明月光，\n疑是地上霜。', type: 'poetry', difficulty: 'hard', tags: ['唐诗'], notes: '李白', isClassic: true });
    assert.equal(second.status, 201); poem = second.data.item;
    assert.equal((await app.request('/api/materials')).data.items.length, 2);
    assert.equal((await app.request('/api/materials/' + poem.id)).data.item.text, poem.text);
    assert.equal((await app.request('/api/materials', 'POST', { text: ' 猫 ', type: 'general' })).status, 409);
    assert.equal((await app.request('/api/materials', 'POST', { text: '   ', type: 'general' })).status, 400);
  });
  await t.test('关键词、类型、难度、标签、经典及栏目可以组合', async () => {
    const result = await app.request('/api/materials?' + new URLSearchParams({ q: '李白', type: 'poetry', difficulty: 'hard', tag: '唐诗', classic: 'true', group: 'evergreen' }));
    assert.deepEqual(result.data.items.map(item => item.id), [poem.id]);
    assert.equal((await app.request('/api/materials?group=classic')).data.items.length, 1);
    assert.equal((await app.request('/api/materials?group=trending')).data.items.length, 0);
    assert.equal((await app.request('/api/materials?tag=' + encodeURIComponent('动物'))).data.items[0].id, cat.id);
  });
  await t.test('修改可共享；冲突提示保护其他成员的修改', async () => {
    const updated = await app.request('/api/materials/' + cat.id, 'PATCH', { text: '猫咪', isClassic: true, updatedAt: cat.updatedAt });
    assert.equal(updated.status, 200); assert.equal(updated.data.item.createdAt, cat.createdAt);
    assert.notEqual(updated.data.item.updatedAt, cat.updatedAt);
    assert.equal((await app.request('/api/materials/' + cat.id, 'PATCH', { notes: '过期编辑', updatedAt: cat.updatedAt })).status, 409);
    cat = updated.data.item;
  });
  await t.test('批量导入先预览；存在错误时不写入；重复自动跳过', async () => {
    const items = [{ text: '太阳', type: 'general' }, { text: '', type: 'lyrics', row: 7 }, { text: '猫咪', type: 'general' }];
    const preview = await app.request('/api/materials/import?preview=1', 'POST', { items });
    assert.deepEqual([preview.data.added, preview.data.invalid, preview.data.duplicates], [1, 1, 1]);
    assert.equal(preview.data.rows[1].row, 7);
    assert.equal((await app.request('/api/materials')).data.items.length, 2);
    const rejected = await app.request('/api/materials/import', 'POST', { items });
    assert.equal(rejected.status, 422); assert.equal((await app.request('/api/materials')).data.items.length, 2);
    const committed = await app.request('/api/materials/import', 'POST', { items: [items[0], items[2], { ...items[0] }] });
    assert.deepEqual([committed.data.added, committed.data.duplicates], [1, 2]);
    assert.equal((await app.request('/api/materials')).data.items.length, 3);
    assert.equal((await app.request('/api/materials/import', 'POST', { items: [] })).status, 400);
  });
  await t.test('两种纯文本和 CSV 均导出当前筛选；CSV 可重新导入', async () => {
    const lines = await app.request('/api/materials/export?format=lines&type=general');
    assert.equal(lines.status, 200); assert.match(lines.data, /猫咪/); assert.match(lines.data, /太阳/); assert.doesNotMatch(lines.data, /床前/);
    assert.equal(lines.data.replace(/^\uFEFF/, '').trim().split('\n').length, 2);
    const joined = await app.request('/api/materials/export?format=dunhao&type=general');
    assert.match(joined.data, /猫咪、太阳|太阳、猫咪/);
    const singleLine = await app.request('/api/materials/export?format=lines&type=poetry');
    assert.equal(singleLine.data.trim().split('\n').length, 1);
    const csv = await app.request('/api/materials/export?format=csv');
    const parsed = parseMaterialCSV(csv.data); assert.equal(parsed.length, 3); assert.equal(parsed.find(item => item.type === 'poetry').text, poem.text);
    const template = await app.request('/api/materials/template');
    assert.equal(parseMaterialCSV(template.data).length, 3);
    assert.ok(parseMaterialCSV(template.data).some(item => item.type === 'sentence'));
  });
  await t.test('限制静态文件范围并阻止跨站修改', async () => {
    assert.equal((await app.request('/')).status, 200);
    assert.equal((await app.request('/data/materials.sqlite')).status, 404);
    assert.equal((await app.request('/server.mjs')).status, 404);
    const blocked = await app.request('/api/materials', 'POST', { text: '外站', type: 'general' }, { Origin: 'https://example.com' });
    assert.equal(blocked.status, 403);
  });
  await t.test('重启服务后数据仍在，删除后不会重新生成', async () => {
    await app.close(); app = await start(filename);
    assert.equal((await app.request('/api/materials')).data.items.length, 3);
    assert.equal((await app.remove('/api/materials/' + cat.id)).status, 204);
    assert.equal((await app.request('/api/materials/' + cat.id)).status, 404);
    for (const item of (await app.request('/api/materials')).data.items) await app.remove('/api/materials/' + item.id);
    await app.close(); app = await start(filename, true);
    assert.equal((await app.request('/api/materials')).data.items.length, 0);
  });
});

test('整理后的题库包含 166 条来源素材与 3 条演示；保留修改与删除结果', async () => {
  const app = await start(':memory:', true);
  try {
    const { data } = await app.request('/api/materials');
    assert.equal(data.items.length, 169); assert.equal(data.items.filter(item => item.isDemo).length, 3);
    assert.equal(data.items.filter(item => item.isClassic).length, 0);
    assert.equal(data.items.find(item => item.text === '北').type, 'general');
    assert.equal(data.items.find(item => item.text === '烧心').type, 'meme');
    assert.equal(data.items.find(item => item.text === '你我怎么两清怎么忍心').type, 'lyrics');
    assert.equal(data.items.filter(item => item.type === 'lyrics').length, 27);
    assert.equal(data.items.find(item => item.text === '司马光').type, 'general');
    assert.equal(data.items.find(item => item.text === '屋檐雨落滴滴答，新生希望在枝桠').type, 'lyrics');
    assert.equal(data.items.find(item => item.text === '这世界有那么多人，多幸运我有个我们').type, 'lyrics');
    assert.equal(data.items.filter(item => item.source === '传声筒.pptx').length, 11);
    assert.equal(data.items.find(item => item.text === '牛马面包').type, 'meme');
    assert.equal(data.items.find(item => item.text === '前人栽树，后人乘凉').type, 'sentence');
    assert.equal(data.items.find(item => item.text === '十年树木百年树人').type, 'sentence');
    assert.equal(data.items.find(item => item.text === '马到成功').type, 'general');
    assert.equal(data.items.find(item => item.text === '手语为桥，心意相通').type, 'sentence');
    assert.equal(data.items.find(item => item.text === '红楼飞雪，一时英杰').type, 'lyrics');
    assert.equal(data.items.find(item => item.text === '先哲曾书写，爱国进步民主科学').type, 'lyrics');
    for (const text of ['再让我听见新三国的梗我就扎聋自己的耳朵', '不烧心，规矩不能坏', '红楼飞雪，一时英杰，先哲曾书写，爱国进步民主科学', '我们一起去图书馆看书', '大家互相帮忙完成任务', '周末结伴去山里看风景', '朋友送给我一份小礼物', '下雨天记得小心走路', '演员在台上表演舞蹈', '傍晚的晚霞十分好看', '我们合作完成这次活动', '风把云朵吹向远方']) {
      assert.equal(data.items.some(item => item.text === text), false, `不应重新加入已删除或替换的素材：${text}`);
    }
    assert.equal(data.items.some(item => item.text === '风把云朵吹响远方' || item.text === '连展'), false);
    assert.equal(data.items.filter(item => item.text === '星星').length, 1);
    assert.equal(data.items.filter(item => item.type === 'general').length, 103);
    assert.equal(data.items.filter(item => item.type === 'sentence').length, 4);
    assert.equal(data.items.some(item => item.text === '北京大学爱心社手语分社'), false);
    const multiline = data.items.find(item => item.notes === '歌曲：《小美满》');
    assert.equal(multiline.type, 'lyrics');
    assert.equal(multiline.text, '你看\n小狗在叫树叶会笑\n风声在呢喃');
  } finally { await app.close(); }
});

test('经典句子支持分类迁移、单条录入、批量导入、筛选、导出与持久化', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bihua-sentences-'));
  const filename = join(directory, 'materials.sqlite');
  let app = await start(filename);
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const old = (await app.request('/api/materials', 'POST', {
    text: '前人栽树，后人乘凉', type: 'general', tags: ['谚语'], notes: '原课件第 11 页', source: '传声筒.pptx', isClassic: true,
  })).data.item;
  const moved = await app.request('/api/materials/' + old.id, 'PATCH', { type: 'sentence', updatedAt: old.updatedAt });
  assert.equal(moved.status, 200);
  assert.equal(moved.data.item.id, old.id);
  assert.equal(moved.data.item.createdAt, old.createdAt);
  assert.equal(moved.data.item.isClassic, true);
  assert.deepEqual(moved.data.item.tags, old.tags);
  assert.equal(moved.data.item.notes, old.notes);
  assert.equal(moved.data.item.source, old.source);

  await app.request('/api/materials', 'POST', { text: '马到成功', type: 'general' });
  const single = await app.request('/api/materials', 'POST', { text: '大家互相帮忙完成任务', type: 'sentence' });
  assert.equal(single.status, 201);
  const items = [{ text: '我们一起去图书馆看书', type: 'sentence' }, { text: '前人栽树，后人乘凉', type: 'sentence' }];
  const preview = await app.request('/api/materials/import?preview=1', 'POST', { items });
  assert.deepEqual([preview.data.added, preview.data.duplicates, preview.data.invalid], [1, 1, 0]);
  assert.equal((await app.request('/api/materials?type=sentence')).data.items.length, 2);
  const imported = await app.request('/api/materials/import', 'POST', { items });
  assert.equal(imported.status, 200);
  assert.deepEqual([imported.data.added, imported.data.duplicates], [1, 1]);
  const sentences = await app.request('/api/materials?group=evergreen&type=sentence');
  assert.equal(sentences.data.items.length, 3);
  assert.ok(sentences.data.items.every(item => item.type === 'sentence'));
  assert.deepEqual((await app.request('/api/materials?group=evergreen&type=general')).data.items.map(item => item.text), ['马到成功']);
  assert.equal((await app.request('/api/materials?group=trending&type=sentence')).data.items.length, 0);
  const exported = await app.request('/api/materials/export?format=csv&type=sentence');
  assert.deepEqual(parseMaterialCSV(exported.data).map(item => item.type), ['sentence', 'sentence', 'sentence']);
  assert.doesNotMatch(exported.data, /马到成功/);

  await app.close(); app = await start(filename, true);
  assert.equal((await app.request('/api/materials?type=sentence')).data.items.length, 3);
  assert.equal((await app.request('/api/materials/' + old.id)).data.item.type, 'sentence');
  assert.equal((await app.remove('/api/materials/' + single.data.item.id)).status, 204);
  assert.equal((await app.request('/api/materials?type=sentence')).data.items.length, 2);
});

test('删除逐次校验姓名与密码；失败不删除，成功记录单条与批量操作者', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bihua-delete-auth-'));
  const filename = join(directory, 'materials.sqlite');
  const app = await start(filename);
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const first = app.store.add({ text: '单条验证词', type: 'general' });
  const second = app.store.add({ text: '批量验证词', type: 'meme' });
  const keep = app.store.add({ text: '保留词', type: 'general' });
  for (const path of ['/api/materials/' + first.id, '/api/materials']) {
    const extra = path === '/api/materials' ? { ids: [first.id, second.id] } : {};
    for (const [auth, status] of [[undefined, 401], [{ name: '', password: TEST_PASSWORD }, 400], [{ name: '   ', password: TEST_PASSWORD }, 400], [{ name: '测试', password: '' }, 401], [{ name: '测试', password: 'wrong-password' }, 401], [{ name: 'a'.repeat(61), password: TEST_PASSWORD }, 400]]) {
      const result = await app.request(path, 'DELETE', { ...extra, auth });
      assert.equal(result.status, status);
      assert.equal(app.store.list().length, 3);
      assert.ok(!JSON.stringify(result.data).includes(TEST_PASSWORD));
    }
  }
  assert.equal((await app.remove('/api/materials/' + first.id)).status, 204);
  assert.equal((await app.request('/api/materials/' + second.id, 'DELETE', {})).status, 401);
  const bulk = await app.request('/api/materials', 'DELETE', { ids: [second.id, second.id, first.id], auth: { name: '  小手  ', password: TEST_PASSWORD } });
  assert.deepEqual(bulk.data, { deleted: 1, alreadyDeleted: 1 });
  assert.deepEqual(app.store.list(), [keep]);
  const auditDb = new DatabaseSync(filename);
  const logs = auditDb.prepare('SELECT * FROM deletion_audit ORDER BY id').all(); auditDb.close();
  assert.deepEqual(logs.map(row => row.actor_name), ['测试管理员', '小手']);
  assert.deepEqual(logs.map(row => row.material_id), [first.id, second.id]);
  assert.ok(logs.every(row => row.material_text && row.deleted_at));
  assert.ok(!JSON.stringify(logs).includes(TEST_PASSWORD));
  for (const asset of ['/', '/app.js', '/styles.css', '/shared.js']) {
    const result = await app.request(asset);
    assert.equal(result.status, 200);
    assert.ok(!result.data.includes(TEST_PASSWORD) && !result.data.includes(TEST_RECORD.hash));
  }
  for (const asset of ['/data/admin.json', '/lib/admin.mjs', '/scripts/set-admin-password.mjs']) assert.equal((await app.request(asset)).status, 404);
});

test('未配置管理员密码时禁止删除，新增、编辑、经典标记与导入仍开放', async t => {
  const app = await start(':memory:', false, null);
  t.after(() => app.close());
  const created = await app.request('/api/materials', 'POST', { text: '开放新增', type: 'general' });
  assert.equal(created.status, 201);
  const id = created.data.item.id;
  assert.equal((await app.request('/api/materials/' + id, 'PATCH', { text: '开放编辑', isClassic: true })).status, 200);
  assert.equal((await app.request('/api/materials/import', 'POST', { items: [{ text: '开放导入', type: 'meme' }] })).status, 200);
  assert.equal((await app.remove('/api/materials/' + id)).status, 503);
  assert.equal((await app.remove('/api/materials', { ids: [id] })).status, 503);
  assert.equal(app.store.list().length, 2);
});

test('密码使用随机盐，错误尝试按来源限频，窗口结束后恢复验证', async () => {
  const another = createPasswordRecord(TEST_PASSWORD);
  assert.notEqual(another.salt, TEST_RECORD.salt);
  assert.notEqual(another.hash, TEST_RECORD.hash);
  assert.throws(() => createDeleteVerifier({ version: 1, salt: 'bad', hash: 'bad' }), /无效/);
  let time = 0;
  const verify = createDeleteVerifier(TEST_RECORD, { now: () => time });
  for (let index = 0; index < 10; index++) await assert.rejects(verify({ name: '测试' + index, password: 'wrong-password' }, 'one-device'), { status: 401 });
  await assert.rejects(verify(TEST_AUTH, 'one-device'), error => error.status === 429 && error.retryAfter === 300);
  assert.equal(await verify(TEST_AUTH, 'another-device'), TEST_AUTH.name);
  time = 300001;
  assert.equal(await verify(TEST_AUTH, 'one-device'), TEST_AUTH.name);
});
