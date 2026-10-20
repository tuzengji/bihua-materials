# 飞手传书维护入口

- 设计者：王宁静。正式地址：`https://shouyulove.cn/flyinghands/`。
- 用户明确要求按原仓库功能公开部署，保留公开共建；不要自行加入账号或管理口令。
- `origin` 为 `tuzengji/bihua-materials`，`upstream` 为 `Lynn07160419/bihua-materials`。原仓库只有读取权限，本机调整在部署 fork 中提交推送。
- 维护服务器为 `ssh shouyulove-aliyun`（`101.37.209.227`），禁止使用 `yanyuan-calendar`。
- 只发布 `web/server.mjs`、`web/package.json`、`web/lib/*.mjs` 与 `web/public/*`；原始题库、课件、计划、数据库、备份和验证记录不进入静态目录。
- 运行服务为 `flyinghands.service`，只监听 `127.0.0.1:8766`。独立 Node.js 24 在 `/opt/flyinghands/node`，不要替换系统 Node.js。
- 数据库固定 `/var/lib/flyinghands/materials.sqlite`，更新代码不能覆盖数据库或重新导入种子素材。
- 新改动需测试、提交推送及更新服务器；主站正文先同步 `/Users/wishingcat/ObsidianNotes/AI Study/爱心社/心创组主站-以手予爱.md`。
- 参见 `deploy/README.md`，更改 Nginx 时持 `/run/lock/nginx-deploy.lock`，先备份并执行 `nginx -t`。
