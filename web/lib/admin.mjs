import { randomBytes, scrypt as scryptCallback, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 10;

class AdminAuthError extends Error {
  constructor(message, status, retryAfter) {
    super(message); this.status = status; this.retryAfter = retryAfter;
  }
}

function validRecord(record) {
  return record?.version === 1 && /^[a-f0-9]{32}$/.test(record.salt) && /^[a-f0-9]{64}$/.test(record.hash);
}

export function createPasswordRecord(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 1024) throw new Error('管理员密码需为 8–1024 个字符');
  const salt = randomBytes(16).toString('hex');
  return { version: 1, salt, hash: scryptSync(password, salt, 32).toString('hex') };
}

export function readPasswordRecord(filename) {
  let record;
  try { record = JSON.parse(readFileSync(filename, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('管理员密码配置无法读取，请重新运行 npm run admin:password');
  }
  if (!validRecord(record)) throw new Error('管理员密码配置无效，请重新运行 npm run admin:password');
  return record;
}

export function createDeleteVerifier(record, { now = Date.now } = {}) {
  if (record && !validRecord(record)) throw new Error('管理员密码配置无效');
  const attempts = new Map();
  return async function verify(credentials, address = 'local') {
    if (!record) throw new AdminAuthError('管理员密码尚未配置，请联系管理员', 503);
    if (!credentials || typeof credentials !== 'object') throw new AdminAuthError('删除前请填写姓名／昵称和管理员密码', 401);
    const name = typeof credentials.name === 'string' ? credentials.name.trim() : '';
    if (!name || name.length > 60 || /[\p{Cc}\p{Cf}]/u.test(name)) throw new AdminAuthError('请填写 1–60 个字符的姓名／昵称', 400);
    const password = credentials.password;
    if (typeof password !== 'string' || !password || password.length > 1024) throw new AdminAuthError('请填写管理员密码', 401);
    const time = now();
    for (const [key, entry] of attempts) if (entry.until <= time) attempts.delete(key);
    if (!attempts.has(address) && attempts.size >= 4096) throw new AdminAuthError('验证请求过多，请稍后重试', 429, 60);
    const entry = attempts.get(address) || { count: 0, until: time + WINDOW_MS };
    if (entry.count >= MAX_ATTEMPTS) throw new AdminAuthError('密码尝试次数过多，请稍后重试', 429, Math.max(1, Math.ceil((entry.until - time) / 1000)));
    // Count in-flight attempts too, so concurrent requests cannot bypass the limit.
    entry.count++; attempts.set(address, entry);
    const candidate = await scrypt(password, record.salt, 32);
    if (!timingSafeEqual(candidate, Buffer.from(record.hash, 'hex'))) throw new AdminAuthError('管理员密码不正确，未删除任何素材', 401);
    attempts.delete(address);
    return name;
  };
}
