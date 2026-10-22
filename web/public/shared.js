export const TYPES = { poetry: '诗词', general: '经典词语', sentence: '经典句子', meme: '梗', lyrics: '歌词' };
export const DIFFICULTIES = { easy: '简单', normal: '普通', hard: '挑战' };
export const GROUPS = { evergreen: ['poetry', 'general', 'sentence'], trending: ['meme', 'lyrics'] };

export class ValidationError extends Error {}

export function normalizeTags(value = []) {
  const list = typeof value === 'string' ? value.split(/[,，、|;；\n]+/) : value;
  if (!Array.isArray(list) || list.some(tag => typeof tag !== 'string')) throw new ValidationError('标签格式不正确');
  const tags = [...new Set(list.map(tag => tag.trim()).filter(Boolean))];
  if (tags.length > 12 || tags.some(tag => tag.length > 30)) throw new ValidationError('最多 12 个标签，每个不超过 30 字');
  return tags;
}

function textField(value, label, max, required = false) {
  if (typeof value !== 'string') throw new ValidationError(`${label}需要是文字`);
  const result = value.replace(/\r\n?/g, '\n').trim();
  if (required && !result) throw new ValidationError(`请填写${label}`);
  if (result.length > max) throw new ValidationError(`${label}不能超过 ${max} 字`);
  return result;
}

export function normalizeMaterial(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('素材格式不正确');
  const text = textField(input.text, '题目', 10000, true);
  if (!Object.hasOwn(TYPES, input.type)) throw new ValidationError('请选择诗词、经典词语、经典句子、梗或歌词');
  const difficulty = input.difficulty || 'normal';
  if (!Object.hasOwn(DIFFICULTIES, difficulty)) throw new ValidationError('难度需要是简单、普通或挑战');
  if (input.isClassic !== undefined && typeof input.isClassic !== 'boolean') throw new ValidationError('经典标记格式不正确');
  if (input.isDemo !== undefined && typeof input.isDemo !== 'boolean') throw new ValidationError('演示标记格式不正确');
  return {
    text, type: input.type, difficulty, tags: normalizeTags(input.tags),
    notes: textField(input.notes ?? '', '备注', 2000),
    source: textField(input.source ?? '', '来源', 200),
    isClassic: input.isClassic ?? false, isDemo: input.isDemo ?? false,
  };
}

export function signature(material) {
  return material.type + ':' + material.text.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function filterMaterials(materials, filters = {}) {
  const query = (filters.q || '').trim().toLocaleLowerCase();
  const tags = normalizeTags(filters.tags ?? filters.tag ?? []);
  return materials.filter(item => {
    if (filters.group === 'classic' && !item.isClassic) return false;
    if (GROUPS[filters.group] && !GROUPS[filters.group].includes(item.type)) return false;
    if (filters.type && filters.type !== 'all' && item.type !== filters.type) return false;
    if (filters.difficulty && filters.difficulty !== 'all' && item.difficulty !== filters.difficulty) return false;
    if ((filters.classic === 'true' || filters.classic === true) && !item.isClassic) return false;
    if ((filters.classic === 'false' || filters.classic === false) && item.isClassic) return false;
    if (tags.length && !tags.every(tag => item.tags.includes(tag))) return false;
    return !query || [item.text, item.notes, item.source, ...item.tags].join(' ').toLocaleLowerCase().includes(query);
  });
}

export function parseCSV(input) {
  const text = input.replace(/^\uFEFF/, '');
  const rows = [];
  let cells = [], field = '', inQuotes = false, afterQuote = false;
  let line = 1, startLine = 1;
  const finishField = () => { cells.push(field); field = ''; afterQuote = false; };
  const finishRow = () => {
    finishField();
    if (cells.some(cell => cell.trim())) rows.push({ cells, row: startLine });
    cells = []; startLine = line + 1;
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; afterQuote = true; }
      } else if (char === '\r' || char === '\n') {
        if (char === '\r' && text[i + 1] === '\n') i++;
        field += '\n'; line++;
      } else field += char;
    } else if (char === ',') finishField();
    else if (char === '\r' || char === '\n') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      finishRow(); line++;
    } else if (char === '"' && !field && !afterQuote) inQuotes = true;
    else if (afterQuote && /[ \t]/.test(char)) continue;
    else if (char === '"' || afterQuote) throw new ValidationError(`CSV 第 ${line} 行引号格式不正确`);
    else field += char;
  }
  if (inQuotes) throw new ValidationError(`CSV 第 ${startLine} 行缺少闭合引号`);
  if (field || cells.length || afterQuote) finishRow();
  return rows;
}

const HEADER_ALIASES = {
  '题目': 'text', '题目正文': 'text', text: 'text',
  '类型': 'type', type: 'type', '难度': 'difficulty', difficulty: 'difficulty',
  '标签': 'tags', tags: 'tags', '备注': 'notes', notes: 'notes',
  '经典': 'isClassic', '经典标记': 'isClassic', isclassic: 'isClassic',
  '来源': 'source', source: 'source', '演示': 'isDemo', isdemo: 'isDemo',
};
const typeAliases = {
  '通用词库': 'general', '古诗词': 'poetry', '梗句': 'meme',
  ...Object.fromEntries(Object.entries(TYPES).flatMap(([key, label]) => [[key, key], [label, key]])),
};
const difficultyAliases = Object.fromEntries(Object.entries(DIFFICULTIES).flatMap(([key, label]) => [[key, key], [label, key]]));

function parseBoolean(value = '') {
  const token = value.trim().toLowerCase();
  if (['是', 'true', '1'].includes(token)) return true;
  if (['', '否', 'false', '0'].includes(token)) return false;
  return value;
}

export function parseMaterialCSV(text) {
  const rows = parseCSV(text);
  if (!rows.length) throw new ValidationError('CSV 文件为空');
  const headers = rows[0].cells.map(cell => HEADER_ALIASES[cell.trim().toLowerCase()] ?? null);
  if (!headers.includes('text') || !headers.includes('type')) throw new ValidationError('CSV 需要“题目”和“类型”两列，可先下载模板');
  const knownHeaders = headers.filter(Boolean);
  if (new Set(knownHeaders).size !== knownHeaders.length) throw new ValidationError('CSV 中有重复的列名');
  return rows.slice(1).map(({ cells, row }) => {
    const item = { row };
    for (let index = 0; index < headers.length; index++) if (headers[index]) item[headers[index]] = cells[index] ?? '';
    item.type = typeAliases[item.type?.trim()] ?? item.type;
    item.difficulty = difficultyAliases[item.difficulty?.trim()] ?? (item.difficulty || 'normal');
    item.isClassic = parseBoolean(item.isClassic);
    item.isDemo = parseBoolean(item.isDemo);
    item.source = item.source ?? 'CSV 导入';
    if (cells.length !== headers.length) item.importError = '列数与表头不一致，请检查逗号和引号';
    return item;
  });
}

export function materialsCSV(materials) {
  const rows = [['题目', '类型', '难度', '标签', '经典', '备注', '来源', '演示']];
  for (const item of materials) rows.push([
    item.text, TYPES[item.type], DIFFICULTIES[item.difficulty], item.tags.join('、'),
    item.isClassic ? '是' : '否', item.notes, item.source, item.isDemo ? '是' : '否',
  ]);
  return '\uFEFF' + rows.map(row => row.map(value => '"' + String(value).replaceAll('"', '""') + '"').join(',')).join('\r\n') + '\r\n';
}

export function materialsText(materials, format) {
  return '\uFEFF' + materials.map(item => item.text.replace(/\s*\n\s*/g, ' ')).join(format === 'dunhao' ? '、' : '\n') + '\n';
}

export class DrawRound {
  constructor(materials, random = Math.random) {
    this.deck = materials.map(item => ({ ...item, tags: [...item.tags] }));
    for (let i = this.deck.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [this.deck[i], this.deck[j]] = [this.deck[j], this.deck[i]];
    }
    this.index = 0; this.revealed = false;
  }
  get current() { return this.deck[this.index] ?? null; }
  get finished() { return this.index >= this.deck.length; }
  toggle() { if (this.current) this.revealed = !this.revealed; }
  next() { if (!this.finished) this.index++; this.revealed = false; }
}
