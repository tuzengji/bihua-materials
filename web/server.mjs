import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, extname } from 'node:path';
import { networkInterfaces } from 'node:os';
import { createStore, StoreError } from './lib/store.mjs';
import { materialsCSV, materialsText, ValidationError } from './public/shared.js';

const root = dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 5 * 1024 * 1024;
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const allowedStatic = new Set(['/index.html', '/styles.css', '/app.js', '/shared.js', '/favicon.svg']);

async function readJSON(request) {
  if (!request.headers['content-type']?.includes('application/json')) throw new StoreError('请使用 JSON 格式提交素材', 415);
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new StoreError('提交内容不能超过 5 MB', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new StoreError('提交内容不是有效的 JSON'); }
}

function sendJSON(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

export function createApp({ dbPath = join(root, 'data', 'materials.sqlite'), seed = true } = {}) {
  const store = createStore(dbPath, { seed });
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'");
    try {
      const url = new URL(request.url, 'http://localhost');
      const path = url.pathname, method = request.method;
      if (['POST', 'PATCH', 'DELETE'].includes(method)) {
        const origin = request.headers.origin;
        if (origin && new URL(origin).host !== request.headers.host) throw new StoreError('请从素材库页面提交修改', 403);
      }
      if (path === '/api/health' && method === 'GET') return sendJSON(response, 200, { ok: true });
      const filters = Object.fromEntries(url.searchParams);
      if (path === '/api/materials/export' && method === 'GET') {
        const format = url.searchParams.get('format') || 'csv';
        if (!['csv', 'lines', 'dunhao'].includes(format)) throw new StoreError('不支持这种导出格式');
        const items = store.list(filters);
        const suffix = format === 'csv' ? 'csv' : 'txt';
        const label = format === 'dunhao' ? '顿号连接' : format === 'lines' ? '一行一条' : '完整表格';
        const name = `飞手传书-${label}-${new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })}.${suffix}`;
        response.writeHead(200, { 'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`, 'Cache-Control': 'no-store' });
        return response.end(format === 'csv' ? materialsCSV(items) : materialsText(items, format));
      }
      if (path === '/api/materials/template' && method === 'GET') {
        response.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent('素材导入模板.csv') });
        return response.end(materialsCSV([
          { text: '孙悟空', type: 'general', difficulty: 'normal', tags: ['人物'], isClassic: false, notes: '', source: '导入模板', isDemo: true },
          { text: '我们一起去图书馆看书', type: 'sentence', difficulty: 'normal', tags: [], isClassic: false, notes: '', source: '导入模板', isDemo: true },
          { text: '床前明月光，\n疑是地上霜。', type: 'poetry', difficulty: 'normal', tags: ['唐诗'], isClassic: false, notes: '李白《静夜思》', source: '导入模板', isDemo: true },
        ]));
      }
      if (path === '/api/materials/import' && method === 'POST') {
        const body = await readJSON(request);
        return sendJSON(response, 200, store.import(body?.items, { preview: url.searchParams.get('preview') === '1' }));
      }
      if (path === '/api/materials') {
        if (method === 'GET') return sendJSON(response, 200, { items: store.list(filters) });
        if (method === 'POST') return sendJSON(response, 201, { item: store.add(await readJSON(request)) });
        if (method === 'DELETE') {
          const body = await readJSON(request);
          return sendJSON(response, 200, store.removeMany(body?.ids));
        }
        throw new StoreError('不支持这个操作', 405);
      }
      const match = path.match(/^\/api\/materials\/([a-zA-Z0-9-]+)$/);
      if (match) {
        if (method === 'GET') return sendJSON(response, 200, { item: store.get(match[1]) });
        if (method === 'PATCH') {
          const body = await readJSON(request);
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw new StoreError('素材格式不正确');
          return sendJSON(response, 200, { item: store.update(match[1], body) });
        }
        if (method === 'DELETE') { store.remove(match[1]); response.writeHead(204); return response.end(); }
        throw new StoreError('不支持这个操作', 405);
      }
      if (path.startsWith('/api/')) throw new StoreError('接口不存在', 404);
      if (method !== 'GET' && method !== 'HEAD') throw new StoreError('不支持这个操作', 405);
      const asset = path === '/' ? '/index.html' : path;
      if (!allowedStatic.has(asset)) throw new StoreError('页面不存在', 404);
      const content = await readFile(join(root, 'public', asset));
      response.writeHead(200, { 'Content-Type': mime[extname(asset)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      response.end(method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (response.headersSent) return response.end();
      const status = error instanceof ValidationError ? 400 : error.status || (error.code === 'ENOENT' ? 404 : 500);
      if (status === 500) console.error(error);
      sendJSON(response, status, { error: status === 500 ? '服务暂时遇到问题，请重试' : error.message, ...(error.details ? { details: error.details } : {}) });
    }
  });
  server.on('close', () => store.close());
  return { server, store };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) { console.error('PORT 需要是 1–65535 之间的整数'); process.exit(1); }
  const { server } = createApp({ dbPath: process.env.MATERIALS_DB || join(root, 'data', 'materials.sqlite') });
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用。可运行 PORT=3001 npm start 更换端口。` : `启动失败：${error.message}`);
    process.exit(1);
  });
  server.listen(port, process.env.HOST || '0.0.0.0', () => {
    console.log(`\n飞手传书 · 游戏素材库\n本机预览：http://localhost:${port}`);
    for (const network of Object.values(networkInterfaces())) for (const address of network || []) {
      if (address.family === 'IPv4' && !address.internal) console.log(`局域网访问：http://${address.address}:${port}`);
    }
    console.log('数据保存在 web/data/materials.sqlite\n按 Ctrl+C 停止服务\n');
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(() => process.exit(0)); server.closeIdleConnections(); });
}
