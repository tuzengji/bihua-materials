import { presentationSupplement } from './presentation-supplement.mjs';
import { manualSupplement } from './manual-supplement.mjs';
import { evergreenSupplement } from './evergreen-supplement.mjs';
import { signature } from '../public/shared.js';

// 来自用户题库；北2 → 北，以及有疑问的台词分类，已由用户确认。
const general = [
  ['北', '方位'], ['孙悟空', '人物'], ['桃', '食物'], ['家', '日常'], ['虎', '动物'],
  ['美', '感受'], ['鱼', '动物'], ['七', '数字'], ['太阳', '自然'], ['爱', '情感'],
  ['牛', '动物'], ['鹿', '动物'], ['星星', '自然'], ['小孩', '人物'], ['晕', '感受'],
  ['什么', '日常'], ['喜欢', '情感'], ['姓名', '日常'], ['猫', '动物'], ['花', '自然'],
].map(([text, tag]) => ({ text, type: 'general', tags: [tag], notes: text === '北' ? '原题库写作“北2”，按用户确认改为“北”。' : '' }));

const lyrics = [
  ['天青色等烟雨，而我在等你', '青花瓷'],
  ['向左，向右，向前看，爱要拐几个弯才来', '遇见'],
  ['还记得你说家是唯一的城堡，随着稻香河流继续奔跑', '稻香'],
  ['我爱你中国，亲爱的母亲，我为你流泪 也为你自豪', '我爱你中国'],
  ['你会翻过山，看到万丈晴天，飞鸟正越过海面', '亲爱的你啊'],
  ['夜空中最亮的星，请指引我靠近你', '夜空中最亮的星'],
  ['在遗忘中不舍 醉醒交错，青春大概如你所说', '青春大概'],
  ['开始的开始 我们都是孩子，最后的最后 渴望变成天使', '北京东路的日子'],
  ['红楼飞雪，一时英杰', '燕园情'],
  ['夏天夏天悄悄过去留下小秘密', ''],
  ['你发如雪凄美了离别', ''],
  ['我遇见谁会有怎样的对白', ''],
  ['我是只化身孤岛的蓝鲸', ''],
  ['你我怎么两清怎么忍心', ''],
].map(([text, song]) => ({ text, type: 'lyrics', tags: [], notes: song ? `歌曲：《${song}》` : '' }));

// 题库.md 后续补充的歌词；同一首歌的连续多行保留为一道题。
export const lyricSupplement = [
  ['妹妹你坐船头，哥哥我岸上走', '纤夫的爱'],
  ['爱是不嫉妒 不张狂 不求自己', '唯一'],
  ['一万匹脱缰的马，在他脑海中奔跑', '杀死那个石家庄人'],
  ['你说到底为什么都是我的错\n都把爱情想得太美现实太诱惑', '全是爱'],
  ['你看\n小狗在叫树叶会笑\n风声在呢喃', '小美满'],
  ['跟着我左手右手一个慢动作', '青春修炼手册'],
  ['你是我天边最美的云彩', '最炫民族风'],
  ['在遗忘中不舍，醉醒交错', '青春大概'],
  ['你会挽着我的衣袖，我会把手揣进裤兜', '成都'],
  ['你与太阳挥手 也同海鸥问候', '化身孤岛的鲸'],
].map(([text, song]) => ({
  text, type: 'lyrics', difficulty: 'normal', tags: [], notes: `歌曲：《${song}》`,
  source: '题库.md', isClassic: false, isDemo: false,
}));

const memes = [
  '早知他来，我便不来了',
  '臣妾要告发熹贵妃私通', '烧心', '臣妾做不到啊',
  '命运的齿轮开始转动了', '你的胆子真是肥嘟嘟的', '暂时不能给你明确的答复！',
].map(text => ({ text, type: 'meme', tags: ['台词'], notes: '' }));

const poetry = [
  ['床前明月光，\n疑是地上霜。', '李白《静夜思》'],
  ['白日依山尽，\n黄河入海流。', '王之涣《登鹳雀楼》'],
  ['春眠不觉晓，\n处处闻啼鸟。', '孟浩然《春晓》'],
].map(([text, notes]) => ({ text, type: 'poetry', tags: ['唐诗'], notes, source: '演示素材', isDemo: true }));

// 交错排列类型，让初始页面能直接看到不同素材；经典标记保留给活动成员。
export const seedMaterials = [];
for (let index = 0; index < 20; index++) {
  for (const list of [general, lyrics, memes, poetry]) {
    if (list[index]) seedMaterials.push({ difficulty: 'normal', source: '题库.md', isClassic: false, isDemo: false, ...list[index] });
  }
}
const seen = new Set(seedMaterials.map(signature));
for (const item of [...lyricSupplement, ...presentationSupplement, ...manualSupplement, ...evergreenSupplement]) {
  const key = signature(item);
  if (!seen.has(key)) { seedMaterials.push(item); seen.add(key); }
}
