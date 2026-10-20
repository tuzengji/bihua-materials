import { TYPES, GROUPS, normalizeTags, filterMaterials, parseMaterialCSV, materialsCSV, materialsText, DrawRound } from './shared.js';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const DISPLAY_TYPE_ORDER = ['meme', 'lyrics', 'general', 'sentence', 'poetry'];
const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
const state = {
  materials: [], filters: emptyFilters(), view: 'library', limit: 0, expanded: false,
  editing: null, detailId: null, deleting: null, round: null, mode: 'guess',
  importMode: 'csv', csvText: '', importItems: null, previewRevision: 0,
  selecting: false, selectedIds: new Set(),
};
let requestSequence = 0, loaded = false, fingerprint = '', toastTimer, nativeFullscreen = false;

function emptyFilters() { return { q: '', group: 'all', type: 'all' }; }
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('icon'); svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-' + name); svg.append(use); return svg;
}
function button(text, className, action, iconName) {
  const node = element('button', className); node.type = 'button';
  if (iconName) node.append(icon(iconName));
  if (text) node.append(document.createTextNode(text));
  node.addEventListener('click', action); return node;
}
function animateIn(nodes, { distance = 6, duration = 200, stagger = 0 } = {}) {
  if (motionPreference.matches) return;
  const elements = nodes instanceof Element ? [nodes] : [...nodes];
  elements.forEach((node, index) => {
    if (typeof node.animate !== 'function') return;
    for (const animation of node.getAnimations()) if (animation.id === 'bihua-enter') animation.cancel();
    const animation = node.animate([
      { opacity: 0, transform: `translateY(${distance}px)` },
      { opacity: 1, transform: 'translateY(0)' },
    ], { duration, delay: Math.min(index, 6) * stagger, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'backwards' });
    animation.id = 'bihua-enter';
  });
}
motionPreference.addEventListener('change', event => {
  if (event.matches) for (const animation of document.getAnimations()) if (animation.id === 'bihua-enter') animation.cancel();
});
function toast(message) {
  clearTimeout(toastTimer); const node = $('#toast'); node.textContent = message; node.hidden = false;
  toastTimer = setTimeout(() => { node.hidden = true; }, 3800);
}
function inlineError(selector, message = '') { const node = $(selector); node.textContent = message; node.hidden = !message; }
async function api(path, options = {}) {
  const response = await fetch(path.replace(/^\//, ''), { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  if (response.status === 204) return null;
  const body = await response.json();
  if (!response.ok) { const error = new Error(body.error || '请求没有完成，请重试'); error.details = body.details; throw error; }
  return body;
}
function setConnection(ok) {
  const node = $('#sync-status'); node.classList.toggle('connected', ok); node.classList.toggle('offline', !ok);
  node.title = ok ? '共享素材已同步' : '连接中断，点击重试';
  node.setAttribute('aria-label', node.title);
}
async function refresh({ force = false, silent = false } = {}) {
  const sequence = ++requestSequence;
  try {
    const { items } = await api('/api/materials');
    if (sequence !== requestSequence) return;
    const nextFingerprint = JSON.stringify(items);
    if (nextFingerprint !== fingerprint || force || !loaded) {
      const animate = !loaded;
      fingerprint = nextFingerprint; state.materials = items; loaded = true;
      renderCounts(); renderLibrary({ animate });
      if (state.view === 'game' && !state.round) renderGame();
      if ($('#detail-dialog').open && state.detailId) {
        const current = items.find(item => item.id === state.detailId);
        if (current) renderDetail(current);
        else { $('#detail-dialog').close(); toast('这条素材已被其他成员删除'); }
      }
    }
    setConnection(true);
  } catch (error) {
    if (sequence !== requestSequence) return;
    setConnection(false);
    if (!loaded) renderEmpty('还没连上题库', '请确认本地服务正在运行。', '重新连接', () => refresh());
    if (!silent) toast(error.message === 'Failed to fetch' ? '连接中断，请稍后重试' : error.message);
  }
}
function filtered() { return filterMaterials(state.materials, state.filters); }
function selectedMaterials() { return state.materials.filter(item => state.selectedIds.has(item.id)); }
function exportMaterials() { return state.selecting ? selectedMaterials() : filtered(); }
function syncSelectionControls() {
  const count = state.selectedIds.size, items = filtered();
  $('#selection-tools').hidden = !state.selecting;
  $('#selection-count').textContent = `已选 ${count} 条`;
  $('#selection-toggle').textContent = state.selecting ? '取消多选' : '多选';
  $('#selection-toggle').setAttribute('aria-pressed', state.selecting);
  $('#import-open').hidden = state.selecting;
  $('#export-open').disabled = state.selecting && !count;
  $('#export-open').replaceChildren(icon('download'), document.createTextNode(state.selecting ? '导出所选' : '导出'));
  $('#clear-selection').disabled = !count;
  $('#delete-selected').disabled = !count;
  $('#select-results').disabled = !items.length;
  $('#select-results').textContent = items.length && items.every(item => state.selectedIds.has(item.id)) ? '取消全选' : '全选当前结果';
  for (const card of $$('.material-card')) {
    const selected = state.selectedIds.has(card.dataset.id);
    card.classList.toggle('selected-material', selected);
    const checkbox = card.querySelector('.material-checkbox');
    if (checkbox) checkbox.checked = selected;
    if (state.selecting) card.querySelector('.card-open').setAttribute('aria-pressed', selected);
  }
}
function selectMaterial(id, selected) {
  if (selected) state.selectedIds.add(id); else state.selectedIds.delete(id);
  syncSelectionControls();
}
function libraryGroups(items = filtered()) {
  if (state.filters.type !== 'all') return [{ type: state.filters.type, items, showTitle: false }];
  return DISPLAY_TYPE_ORDER.map(type => ({ type, items: items.filter(item => item.type === type), showTitle: true }))
    .filter(group => group.items.length);
}
function visiblePageSize(groups = libraryGroups()) {
  const grid = $('#material-grid'), style = getComputedStyle(grid);
  const columns = parseInt(style.getPropertyValue('--material-columns')) || 2;
  const rowHeight = parseFloat(style.getPropertyValue('--material-row-height'));
  const headingHeight = parseFloat(style.getPropertyValue('--material-heading-height'));
  const gap = parseFloat(style.getPropertyValue('--material-group-gap'));
  let height = grid.clientHeight - (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0), count = 0;
  if (!rowHeight || height <= 0) return 0;
  for (const group of groups) {
    const spacing = (count ? gap : 0) + (group.showTitle ? headingHeight : 0);
    const rows = Math.max(0, Math.floor((height - spacing) / rowHeight));
    const shown = Math.min(group.items.length, columns * rows);
    if (!shown) break;
    count += shown;
    height -= spacing + Math.ceil(shown / columns) * rowHeight;
    if (shown < group.items.length) break;
  }
  return count;
}
function renderCounts() {
  $('#count-evergreen').textContent = state.materials.filter(item => GROUPS.evergreen.includes(item.type)).length;
  $('#count-trending').textContent = state.materials.filter(item => GROUPS.trending.includes(item.type)).length;
  $('#count-classic').textContent = state.materials.filter(item => item.isClassic).length;
}
function syncFilterControls() {
  $('#search').value = state.filters.q;
  $('.subcategory-row').hidden = state.filters.group === 'all';
  for (const node of $$('.collection')) {
    const active = node.dataset.group === state.filters.group;
    node.classList.toggle('active', active); node.setAttribute('aria-pressed', active);
  }
  const types = GROUPS[state.filters.group] || Object.keys(TYPES);
  const categoryPool = filterMaterials(state.materials, { group: state.filters.group });
  $('#subcategory-nav').dataset.group = state.filters.group;
  for (const node of $$('.subcategory')) {
    const type = node.dataset.type;
    node.hidden = type !== 'all' && !types.includes(type);
    const active = type === state.filters.type;
    node.classList.toggle('active', active); node.setAttribute('aria-pressed', active);
    node.querySelector('.subcategory-count').textContent = type === 'all' ? categoryPool.length : categoryPool.filter(item => item.type === type).length;
  }
}
function changedFilters({ animate = false } = {}) {
  state.expanded = false; state.round = null; syncFilterControls(); renderLibrary({ animate });
  $('#material-grid').scrollTop = 0;
}
function resetFilters() { state.selectedIds.clear(); state.filters = emptyFilters(); changedFilters({ animate: true }); }
function chooseCategory(group, type = 'all') {
  state.selectedIds.clear();
  state.filters = { ...emptyFilters(), group, type }; changedFilters({ animate: true });
}
function renderEmpty(title, message, label, action) {
  state.expanded = false; state.limit = 0; $('#material-grid').classList.remove('expanded');
  $('#load-more').setAttribute('aria-expanded', 'false');
  const node = element('div', 'empty-state');
  node.append(element('div', 'empty-star', '✳'), element('h3', '', title));
  if (message) node.append(element('p', '', message));
  if (label) node.append(button(label, 'button button-lilac', action));
  $('#material-grid').replaceChildren(node); $('#load-more').hidden = true;
}
function renderLibrary({ animate = false, fromIndex = 0 } = {}) {
  syncFilterControls();
  const validIds = new Set(filterMaterials(state.materials, { ...state.filters, q: '' }).map(item => item.id));
  for (const id of state.selectedIds) if (!validIds.has(id)) state.selectedIds.delete(id);
  syncSelectionControls();
  const items = filtered();
  const titles = { all: '所有素材', evergreen: '长盛不衰', trending: '引领潮流', classic: '经典永流传' };
  $('#library-title').textContent = state.filters.type === 'all' ? titles[state.filters.group] : TYPES[state.filters.type];
  $('#result-count').textContent = `${items.length} 条`;
  if (!items.length) {
    const noClassic = state.filters.group === 'classic' && !state.materials.some(item => item.isClassic);
    renderEmpty(noClassic ? '好玩的，留在这里' : state.materials.length ? '换个条件找找？' : '第一条好题，等你来加',
      noClassic ? '点亮素材旁的星星，就能收进经典。' : '',
      state.materials.length ? '查看全部素材' : '添加素材', state.materials.length ? resetFilters : () => openEditor());
    if (animate) animateIn($('#material-grid').firstElementChild.children, { duration: 180 });
    return;
  }
  const groups = libraryGroups(items), toggle = $('#load-more'), grid = $('#material-grid');
  // 只显示完整的分组标题和词条行；主动展开后才允许滚动。
  toggle.hidden = true;
  let capacity = visiblePageSize(groups);
  const needsToggle = items.length > capacity;
  toggle.hidden = !needsToggle;
  if (needsToggle) capacity = visiblePageSize(groups);
  else state.expanded = false;
  state.limit = state.expanded ? items.length : capacity;
  grid.classList.toggle('expanded', state.expanded);
  toggle.setAttribute('aria-expanded', state.expanded);
  const fragment = document.createDocumentFragment();
  let remaining = state.limit;
  for (const group of groups) {
    if (!remaining) break;
    const shown = group.items.slice(0, remaining);
    remaining -= shown.length;
    const section = element('section', 'material-group');
    section.setAttribute('aria-label', TYPES[group.type]);
    if (group.showTitle) section.append(element('h3', 'material-group-heading', TYPES[group.type]));
    const cards = element('div', 'material-group-grid');
    for (const item of shown) {
      const card = element('article', 'material-card'); card.dataset.id = item.id;
      if (state.selecting) {
        const choice = element('label', 'card-choice'), checkbox = element('input', 'material-checkbox');
        checkbox.type = 'checkbox'; checkbox.checked = state.selectedIds.has(item.id);
        checkbox.setAttribute('aria-label', `选择词条：${item.text}`);
        checkbox.addEventListener('change', () => selectMaterial(item.id, checkbox.checked));
        choice.append(checkbox); card.append(choice);
      }
      const star = button('', `icon-button favorite-button${item.isClassic ? ' selected' : ''}`, () => toggleClassic(item, star), 'star');
      star.setAttribute('aria-label', `${item.isClassic ? '移出经典永流传' : '收进经典永流传'}：${item.text.slice(0, 30)}`);
      star.setAttribute('aria-pressed', item.isClassic); star.title = item.isClassic ? '移出经典永流传' : '收进经典永流传';
      const open = button('', 'card-open', () => state.selecting ? selectMaterial(item.id, !state.selectedIds.has(item.id)) : openDetail(item.id));
      open.setAttribute('aria-label', `${state.selecting ? '选择词条' : '查看素材'}：${item.text}`);
      if (state.selecting) open.setAttribute('aria-pressed', state.selectedIds.has(item.id));
      open.append(element('h4', `card-text${item.text.length <= 5 ? ' short' : ''}`, item.text));
      card.classList.toggle('selected-material', state.selectedIds.has(item.id));
      card.append(open, star); cards.append(card);
    }
    section.append(cards); fragment.append(section);
  }
  grid.replaceChildren(fragment);
  if (animate) animateIn($$('.material-card').slice(fromIndex), { duration: 220, stagger: 18 });
  toggle.textContent = state.expanded ? '收起词条' : `展开更多 · 还有 ${items.length - state.limit} 条`;
}
function openEditor(item = null) {
  state.editing = item ? { ...item, tags: [...item.tags] } : null;
  $('#editor-form').reset(); inlineError('#editor-error');
  $('#editor-title').textContent = item ? '编辑素材' : '添加素材';
  $('#editor-text').value = item?.text || '';
  $('#editor-type').value = item?.type || (state.filters.type !== 'all' ? state.filters.type : state.filters.group === 'trending' ? 'meme' : 'general');
  $('#editor-notes').value = item?.notes || ''; $('#editor-classic').checked = item?.isClassic || false;
  $('#editor-delete').hidden = !item; $('#editor-save').disabled = false;
  $('#editor-dialog').showModal(); $('#editor-text').focus();
}
async function saveEditor(event) {
  event.preventDefault(); inlineError('#editor-error');
  const save = $('#editor-save'); save.disabled = true;
  try {
    const payload = {
      text: $('#editor-text').value, type: $('#editor-type').value, notes: $('#editor-notes').value,
      isClassic: $('#editor-classic').checked,
      ...(state.editing ? { updatedAt: state.editing.updatedAt } : { source: '成员录入' }),
    };
    const editing = state.editing;
    await api(editing ? `/api/materials/${editing.id}` : '/api/materials', { method: editing ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
    $('#editor-dialog').close();
    if (!editing) { state.selectedIds.clear(); state.filters = emptyFilters(); state.expanded = false; }
    await refresh({ force: true }); toast(editing ? '素材已更新' : '好题已收进素材库');
  } catch (error) { inlineError('#editor-error', error.message); }
  finally { save.disabled = false; }
}
function renderDetail(item) {
  $('#detail-type').className = `type-label type-${item.type}`; $('#detail-type').textContent = TYPES[item.type];
  $('#detail-title').textContent = item.text;
  $('#detail-notes').textContent = item.notes; $('#detail-notes').hidden = !item.notes;
  const classic = $('#detail-classic');
  classic.replaceChildren(icon('star'), document.createTextNode(item.isClassic ? '已收进经典永流传' : '收进经典永流传'));
  classic.classList.toggle('selected', item.isClassic); classic.setAttribute('aria-pressed', item.isClassic);
}
function openDetail(id) {
  const item = state.materials.find(item => item.id === id); if (!item) return toast('素材已被删除，请刷新题库');
  state.detailId = id; renderDetail(item); $('#detail-dialog').showModal();
}
async function toggleClassic(item, node) {
  if (!item) return;
  node.disabled = true;
  try {
    await api(`/api/materials/${item.id}`, { method: 'PATCH', body: JSON.stringify({ isClassic: !item.isClassic, updatedAt: item.updatedAt }) });
    await refresh({ force: true }); toast(item.isClassic ? '已移出经典' : '已收进经典永流传');
  } catch (error) { toast(error.message); await refresh({ silent: true }); }
  finally { node.disabled = false; }
}
function askDelete(item) {
  if (!item) return;
  openDeleteConfirmation([item]);
}
function askDeleteSelection() {
  const items = selectedMaterials(); if (!items.length) return;
  openDeleteConfirmation(items, true);
}
function openDeleteConfirmation(items, batch = false) {
  state.deleting = { items: [...items], batch };
  $('#delete-title').textContent = batch ? `删除所选的 ${items.length} 条素材？` : '删除这条素材？';
  $('#delete-text').textContent = batch ? items.map((item, index) => `${index + 1}. ${item.text}`).join('\n\n') : items[0].text;
  $('#confirm-delete').textContent = batch ? `删除 ${items.length} 条` : '确认删除';
  inlineError('#delete-error');
  $('#confirm-delete').disabled = false; $('#delete-dialog').showModal();
}
async function confirmDelete() {
  const pending = state.deleting; if (!pending) return;
  $('#confirm-delete').disabled = true;
  try {
    const ids = pending.items.map(item => item.id);
    const result = pending.batch
      ? await api('/api/materials', { method: 'DELETE', body: JSON.stringify({ ids }) })
      : await api(`/api/materials/${ids[0]}`, { method: 'DELETE' });
    $('#delete-dialog').close();
    for (const id of ids) state.selectedIds.delete(id);
    if ($('#detail-dialog').open && ids.includes(state.detailId)) $('#detail-dialog').close();
    if ($('#editor-dialog').open && ids.includes(state.editing?.id)) $('#editor-dialog').close();
    await refresh({ force: true });
    toast(!pending.batch ? '素材已删除' : !result.deleted ? '所选素材已被其他成员删除'
      : `已删除 ${result.deleted} 条素材${result.alreadyDeleted ? `，另有 ${result.alreadyDeleted} 条已被删除` : ''}`);
  } catch (error) { inlineError('#delete-error', error.message); }
  finally { $('#confirm-delete').disabled = false; }
}

function clearPreview() {
  state.previewRevision++; state.importItems = null; $('#import-preview').hidden = true;
  $('#commit-import').disabled = true; $('#commit-import').replaceChildren(document.createTextNode('确认导入'), icon('arrow'));
  inlineError('#import-error');
}
function switchImport(mode) {
  state.importMode = mode; clearPreview();
  for (const tab of $$('[data-import-tab]')) {
    const active = tab.dataset.importTab === mode; tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', active); tab.tabIndex = active ? 0 : -1;
  }
  $('#csv-panel').hidden = mode !== 'csv'; $('#paste-panel').hidden = mode !== 'paste';
}
function openImport() {
  state.csvText = ''; $('#csv-file').value = ''; $('#file-name').textContent = '选择或拖入 CSV 文件';
  $('#paste-text').value = ''; $('#paste-tags').value = ''; $('#paste-type').value = state.filters.type !== 'all' ? state.filters.type : state.filters.group === 'trending' ? 'meme' : 'general';
  $('#paste-difficulty').value = 'normal'; switchImport('csv'); $('#import-dialog').showModal();
}
async function loadFile(file) {
  clearPreview(); state.csvText = ''; $('#file-name').textContent = '选择或拖入 CSV 文件';
  if (!file) return;
  const revision = state.previewRevision;
  try {
    if (!file.name.toLowerCase().endsWith('.csv')) throw new Error('请选择 CSV 文件；Excel 表格可先另存为 CSV');
    if (file.size > 5 * 1024 * 1024) throw new Error('文件不能超过 5 MB');
    const bytes = await file.arrayBuffer(); let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { text = new TextDecoder('gb18030', { fatal: true }).decode(bytes); }
    if (revision !== state.previewRevision) return;
    state.csvText = text; $('#file-name').textContent = file.name;
  } catch (error) { inlineError('#import-error', error.message); }
}
function buildImportItems() {
  if (state.importMode === 'csv') {
    if (!state.csvText) throw new Error('请先选择 CSV 文件');
    return parseMaterialCSV(state.csvText);
  }
  const tags = normalizeTags($('#paste-tags').value);
  return $('#paste-text').value.split(/\r?\n/).map((text, index) => ({
    row: index + 1, text: text.trim(), type: $('#paste-type').value,
    difficulty: $('#paste-difficulty').value, tags, source: '批量粘贴',
  })).filter(item => item.text);
}
function renderPreview(report) {
  $('#import-preview').hidden = false;
  const summary = [element('span', '', `可新增 ${report.added} 条`)];
  if (report.duplicates) summary.push(element('span', 'duplicates', `跳过重复 ${report.duplicates} 条`));
  if (report.invalid) summary.push(element('span', 'has-errors', `待修正 ${report.invalid} 条`));
  $('#preview-summary').replaceChildren(...summary);
  const fragment = document.createDocumentFragment();
  // 错误先展示，保留 CSV 原始行号，便于回文件修正。
  const rows = [...report.rows].sort((a, b) => (a.status === 'error' ? -1 : 0) - (b.status === 'error' ? -1 : 0));
  for (const row of rows) {
    const node = element('li', `preview-row ${row.status}`);
    const content = element('div'); content.append(element('span', 'preview-row-text', row.text || '（空题目）'));
    content.append(element('span', 'preview-row-status', [TYPES[row.type], row.message].filter(Boolean).join(' · ')));
    node.append(element('span', 'preview-row-number', `#${row.row}`), content); fragment.append(node);
  }
  $('#preview-rows').replaceChildren(fragment);
  $('#commit-import').disabled = Boolean(report.invalid) || !report.added;
  $('#commit-import').replaceChildren(document.createTextNode(`导入 ${report.added} 条`), icon('arrow'));
  if (report.invalid) inlineError('#import-error', '请在原文件或粘贴内容中修正错误，再次预览。');
}
async function previewImport() {
  clearPreview(); const revision = state.previewRevision; $('#preview-import').disabled = true;
  try {
    const items = buildImportItems();
    if (!items.length) throw new Error('还没有可导入的素材');
    const report = await api('/api/materials/import?preview=1', { method: 'POST', body: JSON.stringify({ items }) });
    if (revision !== state.previewRevision) return;
    state.importItems = items; renderPreview(report);
  } catch (error) { if (revision === state.previewRevision) inlineError('#import-error', error.message); }
  finally { $('#preview-import').disabled = false; }
}
async function commitImport() {
  if (!state.importItems) return;
  let succeeded = false;
  const controls = $$('#import-dialog input, #import-dialog textarea, #import-dialog select, #import-dialog [data-import-tab], #preview-import, #commit-import');
  controls.forEach(node => { node.disabled = true; }); inlineError('#import-error');
  try {
    const report = await api('/api/materials/import', { method: 'POST', body: JSON.stringify({ items: state.importItems }) });
    succeeded = true; $('#import-dialog').close(); state.selectedIds.clear(); state.filters = emptyFilters(); state.expanded = false;
    await refresh({ force: true });
    toast(`已导入 ${report.added} 条${report.duplicates ? `，跳过重复 ${report.duplicates} 条` : ''}`);
  } catch (error) { inlineError('#import-error', error.message); if (error.details) renderPreview(error.details); }
  finally {
    controls.forEach(node => { node.disabled = false; });
    if (succeeded) clearPreview();
    else $('#commit-import').disabled = !state.importItems || Boolean($('#preview-rows .error'));
  }
}
function exportQuery(format) {
  const query = new URLSearchParams({ format });
  for (const [key, value] of Object.entries(state.filters)) if (value && value !== 'all') query.set(key, value);
  return query;
}
function openExport() {
  const items = exportMaterials(); $('#export-count').textContent = `${state.selecting ? '已选词条' : '当前筛选'} · ${items.length} 条素材`;
  const examples = items.slice(0, 3).map(item => item.text.replace(/\s*\n\s*/g, ' '));
  const lineSample = $('.export-option[data-export="lines"] .export-sample');
  lineSample.replaceChildren();
  examples.forEach((text, index) => { if (index) lineSample.append(document.createElement('br')); lineSample.append(document.createTextNode(text)); });
  $('.export-option[data-export="dunhao"] .export-sample').textContent = examples.join('、');
  for (const node of $$('[data-export]')) node.disabled = !items.length;
  $('#export-dialog').showModal();
}
function downloadExport(format) {
  const link = element('a'); let blobURL;
  if (state.selecting) {
    const items = selectedMaterials();
    if (!items.length) { $('#export-dialog').close(); return toast('请先选择词条'); }
    const content = format === 'csv' ? materialsCSV(items) : materialsText(items, format);
    blobURL = URL.createObjectURL(new Blob([content], { type: format === 'csv' ? 'text/csv;charset=utf-8' : 'text/plain;charset=utf-8' }));
    link.href = blobURL;
    const label = format === 'csv' ? '完整表格' : format === 'lines' ? '一行一条' : '顿号连接';
    link.download = `飞手传书-所选${items.length}条-${label}.${format === 'csv' ? 'csv' : 'txt'}`;
  } else { link.href = './api/materials/export?' + exportQuery(format); link.download = ''; }
  document.body.append(link); link.click(); link.remove(); $('#export-dialog').close();
  if (blobURL) setTimeout(() => URL.revokeObjectURL(blobURL), 1000);
}

function showView(view) {
  if (view === 'library') exitFocus();
  state.view = view; $('#library-view').hidden = view !== 'library'; $('#game-view').hidden = view !== 'game';
  $('#nav-library').classList.toggle('active', view === 'library'); $('#nav-game').classList.toggle('active', view === 'game');
  $('#header-add').hidden = view === 'game';
  if (view === 'game') renderGame();
  else { if (loaded) renderLibrary(); refresh({ silent: true }); }
  window.scrollTo(0, 0);
}
function gameHint() { return state.mode === 'relay' ? '只让当前比划者看题，再把动作传下去。' : '让猜题的人背对屏幕，再点击显示。'; }
function renderGameLibraries() {
  const select = $('#game-library'); select.replaceChildren();
  const add = (group, type, label) => {
    const count = filterMaterials(state.materials, { group, type }).length;
    const option = element('option', type === 'all' ? 'game-library-group' : '', `${type === 'all' ? '' : '　'}${label} · ${count}`);
    option.value = `${group}:${type}`; select.append(option);
  };
  add('all', 'all', '全部素材');
  for (const [group, label] of [['evergreen', '长盛不衰'], ['trending', '引领潮流'], ['classic', '经典永流传']]) {
    add(group, 'all', label);
    const types = GROUPS[group] || Object.keys(TYPES).filter(type =>
      state.materials.some(item => item.isClassic && item.type === type) || (state.filters.group === group && state.filters.type === type));
    for (const type of types) add(group, type, TYPES[type]);
  }
  if (state.filters.q.trim()) {
    const current = element('option', '', `当前搜索 · ${filtered().length}`); current.value = 'current'; select.prepend(current);
    select.value = 'current';
  } else select.value = `${state.filters.group}:${state.filters.type}`;
}
function renderGame() {
  renderGameLibraries();
  const content = $('#stage-content'), controls = $('#stage-controls'); content.replaceChildren(); controls.replaceChildren();
  animateIn(content, { duration: 180 });
  $('#restart-round').hidden = !state.round; $('#fullscreen-button').title = document.body.classList.contains('focus-mode') ? '退出全屏' : '全屏展示';
  for (const node of $$('.mode-button')) { const active = node.dataset.mode === state.mode; node.classList.toggle('active', active); node.setAttribute('aria-pressed', active); }
  const round = state.round, pool = filtered();
  if (!round) {
    $('#game-counter').textContent = `${pool.length} 道待抽`;
    content.append(element('div', 'stage-symbol', '✳'), element('h2', '', pool.length ? '好题已就位' : '还没有选中题目'));
    if (pool.length) content.append(element('p', '', gameHint()));
    controls.append(button(pool.length ? '开始抽题' : '返回选题', 'button button-dark', pool.length ? startRound : () => showView('library'), pool.length ? 'arrow' : 'library'));
    return;
  }
  if (round.finished) {
    $('#game-counter').textContent = '本轮结束';
    content.append(element('div', 'stage-symbol', '✦'), element('h2', '', `${round.deck.length} 道题，抽完啦！`));
    controls.append(button('再来一轮', 'button button-dark', startRound, 'refresh'), button('重新选题', 'button button-stage-secondary', () => { state.round = null; showView('library'); }));
    return;
  }
  $('#game-counter').textContent = `${round.index + 1} / ${round.deck.length} · ${TYPES[round.current.type]}`;
  if (!round.revealed) {
    content.append(element('div', 'stage-symbol', '?'), element('h2', '', '题目已藏好'), element('p', '', gameHint()));
  } else {
    const length = round.current.text.length;
    content.append(element('h2', `game-prompt${length > 80 ? ' long' : length > 14 ? ' medium' : ''}`, round.current.text));
  }
  const reveal = button(round.revealed ? '隐藏题目' : '显示题目', 'button button-dark', () => { round.toggle(); renderGame(); }, round.revealed ? 'hide' : 'eye');
  reveal.id = 'reveal-prompt';
  const next = button(round.index === round.deck.length - 1 ? '结束本轮' : '下一题', 'button button-stage-secondary', () => { round.next(); renderGame(); }, 'arrow'); next.id = 'next-prompt';
  controls.append(reveal, next);
}
function startRound() { state.round = new DrawRound(filtered()); renderGame(); }
async function toggleFocus() {
  if (document.body.classList.contains('focus-mode')) return exitFocus();
  document.body.classList.add('focus-mode'); $('#fullscreen-button').setAttribute('aria-label', '退出全屏');
  $('#fullscreen-button').title = '退出全屏';
  try { if ($('#game-stage').requestFullscreen) { await $('#game-stage').requestFullscreen(); nativeFullscreen = true; } }
  catch { /* 移动端保留铺满视口的展示模式。 */ }
}
async function exitFocus() {
  document.body.classList.remove('focus-mode'); $('#fullscreen-button').setAttribute('aria-label', '全屏展示');
  $('#fullscreen-button').title = '全屏展示';
  if (document.fullscreenElement) { try { await document.exitFullscreen(); } catch {} }
  nativeFullscreen = false;
}

$('#header-add').addEventListener('click', () => openEditor()); $('#mobile-add').addEventListener('click', () => openEditor());
$('#editor-form').addEventListener('submit', saveEditor);
$('#editor-delete').addEventListener('click', () => askDelete(state.editing));
$('#detail-edit').addEventListener('click', () => { const item = state.materials.find(item => item.id === state.detailId); $('#detail-dialog').close(); if (item) openEditor(item); });
$('#detail-delete').addEventListener('click', () => askDelete(state.materials.find(item => item.id === state.detailId)));
$('#detail-classic').addEventListener('click', () => toggleClassic(state.materials.find(item => item.id === state.detailId), $('#detail-classic')));
$('#confirm-delete').addEventListener('click', confirmDelete);
for (const node of $$('[data-close]')) node.addEventListener('click', () => document.getElementById(node.dataset.close).close());
for (const dialog of $$('dialog')) dialog.addEventListener('click', event => {
  if (event.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
});
for (const node of $$('.collection')) node.addEventListener('click', () => {
  chooseCategory(node.dataset.group);
});
for (const node of $$('.subcategory')) node.addEventListener('click', () => {
  const group = state.filters.group === 'classic' ? 'classic' : node.dataset.parent || state.filters.group;
  chooseCategory(group, node.dataset.type);
});
$('#all-categories').addEventListener('click', resetFilters);
$('#search').addEventListener('input', event => { state.filters.q = event.target.value; changedFilters(); });
$('#selection-toggle').addEventListener('click', () => {
  state.selecting = !state.selecting; state.selectedIds.clear(); renderLibrary();
});
$('#select-results').addEventListener('click', () => {
  const items = filtered(), selected = items.every(item => state.selectedIds.has(item.id));
  for (const item of items) { if (selected) state.selectedIds.delete(item.id); else state.selectedIds.add(item.id); }
  syncSelectionControls();
});
$('#clear-selection').addEventListener('click', () => { state.selectedIds.clear(); syncSelectionControls(); });
$('#delete-selected').addEventListener('click', askDeleteSelection);
$('#load-more').addEventListener('click', () => {
  const fromIndex = state.expanded ? 0 : state.limit;
  state.expanded = !state.expanded;
  renderLibrary({ animate: true, fromIndex }); $('#material-grid').scrollTop = 0;
});
$('#import-open').addEventListener('click', openImport); $('#export-open').addEventListener('click', openExport);
for (const node of $$('[data-import-tab]')) node.addEventListener('click', () => switchImport(node.dataset.importTab));
$('.import-tabs').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault(); const mode = state.importMode === 'csv' ? 'paste' : 'csv'; switchImport(mode); $(`#tab-${mode}`).focus();
});
$('#csv-file').addEventListener('change', event => loadFile(event.target.files[0]));
$('#dropzone').addEventListener('dragover', event => { event.preventDefault(); $('#dropzone').classList.add('dragging'); });
$('#dropzone').addEventListener('dragleave', () => $('#dropzone').classList.remove('dragging'));
$('#dropzone').addEventListener('drop', event => { event.preventDefault(); $('#dropzone').classList.remove('dragging'); loadFile(event.dataTransfer.files[0]); });
for (const node of $$('#paste-panel input, #paste-panel select, #paste-panel textarea')) node.addEventListener('input', clearPreview);
$('#preview-import').addEventListener('click', previewImport); $('#commit-import').addEventListener('click', commitImport);
for (const node of $$('[data-export]')) node.addEventListener('click', () => downloadExport(node.dataset.export));
$('#nav-library').addEventListener('click', () => showView('library')); $('#nav-game').addEventListener('click', () => showView('game'));
$('#game-back').addEventListener('click', () => showView('library'));
$('#game-library').addEventListener('change', event => {
  if (event.target.value === 'current') return;
  const [group, type] = event.target.value.split(':'); chooseCategory(group, type); renderGame();
});
$('#restart-round').addEventListener('click', () => { state.round = null; renderGame(); });
$('#fullscreen-button').addEventListener('click', toggleFocus);
for (const node of $$('.mode-button')) node.addEventListener('click', () => { state.mode = node.dataset.mode; renderGame(); });
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && nativeFullscreen) exitFocus(); });
document.addEventListener('keydown', event => {
  if (state.view !== 'game' || $('dialog[open]') || event.repeat) return;
  if (event.key === 'Escape') { exitFocus(); return; }
  if (event.target.closest('input,textarea,select,[contenteditable="true"]')) return;
  if (event.target.closest('button,a') && !event.target.closest('#game-stage')) return;
  if (!state.round || state.round.finished) return;
  if (event.code === 'Space') { event.preventDefault(); state.round.toggle(); renderGame(); }
  if (event.key === 'ArrowRight') { event.preventDefault(); state.round.next(); renderGame(); }
});
window.addEventListener('focus', () => refresh({ silent: true }));
const gridResizeObserver = new ResizeObserver(() => {
  if (!loaded || state.view !== 'library' || state.expanded || visiblePageSize() === state.limit) return;
  renderLibrary();
});
gridResizeObserver.observe($('#material-grid'));
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh({ silent: true }); });
$('#sync-status').addEventListener('click', () => refresh());
setInterval(() => { if (!document.hidden) refresh({ silent: true }); }, 15000);
refresh();
