import test from 'node:test';
import assert from 'node:assert/strict';
import { DrawRound, normalizeMaterial, materialsCSV, parseMaterialCSV, parseCSV } from '../public/shared.js';

test('CSV 保留中文、逗号、引号、多行及元数据，跳过空行', () => {
  const input = normalizeMaterial({ text: '一句“中文”, 和 "引号"\n下一行', type: 'lyrics', notes: '出处, 备注', tags: ['音乐', '校园'], isClassic: true });
  const result = parseMaterialCSV(materialsCSV([input]) + '\r\n\r\n');
  assert.equal(result.length, 1);
  assert.deepEqual(normalizeMaterial(result[0]), input);
  const rows = parseCSV('\uFEFF题目,类型\r\n"一\r\n二",poetry\r\n\r\n猫,general');
  assert.equal(rows[2].row, 5); assert.equal(rows[1].cells[0], '一\n二');
});
test('CSV 的缺少表头、重复表头、错误引号与列数错误得到提示', () => {
  assert.throws(() => parseMaterialCSV('题目,备注\n猫,说明'), /题目.*类型/);
  assert.throws(() => parseMaterialCSV('题目,text,类型\n猫,猫,general'), /重复/);
  assert.throws(() => parseMaterialCSV('题目,类型\n"没有结束,general'), /闭合/);
  assert.throws(() => parseCSV('猫"咪,general'), /引号/);
  assert.ok(parseMaterialCSV('题目,类型\n猫,general,多出的一列')[0].importError);
  assert.throws(() => normalizeMaterial(parseMaterialCSV('题目,类型,经典\n猫,通用词库,可能')[0]), /经典标记/);
});
test('CSV 导入兼容分类的新旧名称', () => {
  const rows = parseMaterialCSV('题目,类型\n猫,通用词库\n鹿,经典词语\n我们一起去图书馆看书,经典句子\n白日依山尽,古诗词\n春眠不觉晓,诗词\n臣妾做不到啊,梗\n好了好了,梗句\n歌词片段,歌词');
  const items = rows.map(item => normalizeMaterial(item));
  assert.deepEqual(items.map(item => item.type), ['general', 'general', 'sentence', 'poetry', 'poetry', 'meme', 'meme', 'lyrics']);
  const exported = materialsCSV(items);
  assert.match(exported, /经典词语/); assert.match(exported, /经典句子/); assert.match(exported, /诗词/); assert.match(exported, /"梗"/); assert.doesNotMatch(exported, /梗句/);
  assert.deepEqual(parseMaterialCSV(exported).map(item => normalizeMaterial(item)), items);
});
test('出题整轮无重复，换题重新隐藏；题库变化不会改动本轮快照', () => {
  const items = Array.from({ length: 20 }, (_, index) => ({ id: String(index), text: `词${index}`, tags: [] }));
  const round = new DrawRound(items);
  items[0].text = '修改后的词'; items[0].tags.push('新增标签');
  const ids = [];
  while (!round.finished) {
    assert.equal(round.revealed, false); ids.push(round.current.id);
    round.toggle(); assert.equal(round.revealed, true); round.next();
  }
  assert.equal(new Set(ids).size, 20); assert.equal(round.current, null);
  assert.equal(round.deck.find(item => item.id === '0').text, '词0');
  assert.equal(round.deck.find(item => item.id === '0').tags.length, 0);
  round.next(); assert.equal(round.index, 20);
  const empty = new DrawRound([]); assert.equal(empty.finished, true); empty.toggle(); assert.equal(empty.revealed, false);
});
