import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createPasswordRecord } from '../lib/admin.mjs';

function hiddenInput(prompt) {
  process.stdout.write(prompt);
  process.stdin.setRawMode(true); process.stdin.resume();
  return new Promise((resolveInput, reject) => {
    let value = '';
    const finish = () => { process.stdin.off('data', onData); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n'); };
    const onData = chunk => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\u0003') { finish(); reject(new Error('已取消设置')); return; }
        if (char === '\r' || char === '\n') { finish(); resolveInput(value); return; }
        if (char === '\u007f' || char === '\b') value = [...value].slice(0, -1).join('');
        else if (!/[\p{Cc}\p{Cf}]/u.test(char)) value += char;
      }
    };
    process.stdin.on('data', onData);
  });
}

try {
  if (!process.stdin.isTTY) throw new Error('请在交互式终端运行 npm run admin:password');
  const password = await hiddenInput('管理员密码（输入不回显）：');
  const confirmation = await hiddenInput('再次输入管理员密码：');
  if (password !== confirmation) throw new Error('两次输入不一致，未修改配置');
  const record = createPasswordRecord(password);
  const filename = process.env.ADMIN_AUTH_FILE || fileURLToPath(new URL('../data/admin.json', import.meta.url));
  mkdirSync(dirname(resolve(filename)), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(record) + '\n', { mode: 0o600 });
  renameSync(temporary, filename);
  console.log('管理员密码已保存为加盐哈希。重启服务后生效。');
} catch (error) { console.error(error.message); process.exitCode = 1; }
