export const manualSupplement = [
  { text: '司马光', type: 'general', tags: ['人物'] },
  { text: '屋檐雨落滴滴答，新生希望在枝桠', type: 'lyrics', tags: [] },
  { text: '这世界有那么多人，多幸运我有个我们', type: 'lyrics', tags: [] },
  { text: '不爱说话没关系 手语分社欢迎你', type: 'meme', tags: [] },
].map(item => ({
  difficulty: 'normal', notes: '', source: '用户补充', isClassic: false, isDemo: false, ...item,
}));
