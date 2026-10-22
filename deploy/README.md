# 服务器部署

正式入口为 <https://shouyulove.cn/flyinghands/>，在以手予爱主站首页与作品集的「核心创意」中展示，设计者为王宁静。

| 项目 | 位置 |
| --- | --- |
| 主机 | `shouyulove-aliyun` → `101.37.209.227` |
| 代码 | `/opt/flyinghands/releases/<版本>/web` |
| 当前代码 | `/opt/flyinghands/current` |
| 独立运行时 | `/opt/flyinghands/node/bin/node`（24.22.0） |
| 服务 | `flyinghands.service` |
| 监听 | `127.0.0.1:8766` |
| 数据库 | `/var/lib/flyinghands/materials.sqlite` |
| Nginx | `/etc/nginx/snippets/flyinghands.conf` |
| 首发备份 | `/var/backups/flyinghands/20261020-first-release/` |

Nginx 去除 `/flyinghands/` 前缀后转发给 Node.js。网页资源、模板下载和 API 使用相对路径，同时兼容本地根路径。保留原项目的公开共建功能；数据由独立系统用户持有，与代码发布目录分开。

## 更新

先运行 `npm --prefix web test`，检查电脑和手机页面、分类搜索、抽题、导出及素材维护。提交推送部署 fork 后，只打包 `web/server.mjs`、`web/package.json`、`web/lib/*.mjs` 和 `web/public/*`。运行包不包含原始课件、Markdown、测试数据库或 Git。

在 `/opt/flyinghands/releases/` 创建新版本，逐文件验证上传哈希。在私有备份目录使用 SQLite backup API 备份运行数据库，不能直接复制正在写入的 SQLite 主文件。原数据库路径保持不变，切换 `current` 后仅重启 `flyinghands.service`。

检查本机 `/api/health`、正式 `/flyinghands/` 和 `/flyinghands/api/materials`，确认原有素材仍在。若失败，将 `current` 切回旧版本并重启本服务；不要用历史数据库覆盖上线后的用户修改。

更改 Nginx 时，持 `/run/lock/nginx-deploy.lock` 完成备份、修改、`nginx -t`、平滑重载及失败回退。普通代码更新无需改动或重载 Nginx。

## 删除验证

2026-10-22 同步上游 `45af477`，用户确认启用姓名和管理密码验证。服务通过 `ADMIN_AUTH_FILE=/var/lib/flyinghands/admin.json` 读取独立配置；未配置时删除返回 503，其他操作正常。密码文件不纳入 Git 或静态目录。线上现有素材保留，不重新导入上游种子题库。

## 图标

沿用原项目的手掌与纸飞机意象，使用主站现有灰绿描边、米色手掌、灰蓝飞机、豆沙折面和浅绿袖口。可编辑母版在 `web/public/favicon.svg`，主站副本在 `project-logos/20261020-flyinghands/`。使用圆角描边，已检查透明背景和手机尺寸。
