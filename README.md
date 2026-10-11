# DRST Annotation Review

DRST-Bench 的轻量级模型标注复核网站。网页展示 Qwen3.6-27B 生成并经过规则筛选的状态转移候选，复核者只需判断候选应当保留、修改、存疑或排除，而不是从原始对话开始标注。

服务器入口：[https://121.48.161.104:8765](https://121.48.161.104:8765)

面向外部复核者的静态前端位于 `pages/`，通过 GitHub Pages 发布；任务和复核结果由 Supabase 托管，仍需要登录。

## 架构

- GitHub Pages 只发布 `pages/` 中的静态前端，不包含任务文本或复核结果。
- Supabase 存放经登录保护的任务、候选事件与复核结果；行级安全策略拒绝匿名访问。
- 原始本地数据、SQLite 历史复核结果、账号密码和 TLS 证书仍保留在实验服务器。
- 服务器通过 user systemd 运行仓库检出的代码，并用绝对路径挂载本地数据。
- 当前使用自签名 HTTPS 证书，首次访问时浏览器会提示证书不受信任。

## 服务器部署

仓库默认检出到：

```text
/mnt/hdd1/yangyechenhao/services/DRST-annotation
```

部署模板见 `deploy/drst-annotation.service.example`。复制到 `~/.config/systemd/user/drst-annotation.service` 后，将模板中的 `<WORKSPACE>` 替换为保存 DRST 数据的绝对路径，然后执行：

```bash
systemctl --user daemon-reload
systemctl --user enable --now drst-annotation.service
```

查看状态与日志：

```bash
systemctl --user status drst-annotation.service --no-pager
journalctl --user -u drst-annotation.service -f
```

更新网站代码：

```bash
cd /mnt/hdd1/yangyechenhao/services/DRST-annotation
git pull --ff-only
./scripts/validate_checkout.sh
systemctl --user restart drst-annotation.service
```

## GitHub Pages + Supabase 初始化

1. 在 Supabase Dashboard 的 **SQL Editor** 执行 [`supabase/schema.sql`](supabase/schema.sql)。
2. 在 Supabase 的 **Authentication → URL Configuration** 中加入 GitHub Pages 地址，例如 `https://pakastaa.github.io/DRST-annotation/`，用于邮箱确认后的跳转。
3. 仅在服务器终端中设置一次性导入密钥。不要在聊天、命令历史或 Git 中保存它：

```bash
read -rs SUPABASE_SECRET_KEY
export SUPABASE_SECRET_KEY
python scripts/import_supabase.py \
  --trajectories /mnt/hdd1/yangyechenhao/code/dynamic/dataset/DRST_bench_v1/natural/trajectories.jsonl \
  --events /mnt/hdd1/yangyechenhao/code/dynamic/dataset/DRST_bench_v1/probes/review_v3/strict_events.jsonl
unset SUPABASE_SECRET_KEY
```

4. 在 GitHub 仓库 **Settings → Pages** 将 Source 设为 **GitHub Actions**。推送 `main` 后，`deploy-pages` workflow 会发布静态前端。

Supabase 的 publishable key 位于 `pages/config.js`，这是浏览器必需的公开配置；真正保护数据的是 SQL 中的 Row Level Security。`SUPABASE_SECRET_KEY` 拥有导入权限，绝不能提交或发送。

## 本地检查

网站后端仅使用 Python 标准库，前端为原生 HTML/CSS/JavaScript：

```bash
./scripts/validate_checkout.sh
```

更完整的复核方法、标签解释和导出说明见 [`DRST/bench_v1/annotation_web/README.md`](DRST/bench_v1/annotation_web/README.md)。

## 数据安全

不要向仓库提交 `dataset/`、`outputs/`、JSONL 样本、SQLite 数据库、`users.json`、初始密码、Supabase secret key 或 TLS 私钥/证书。仓库的 `.gitignore` 已覆盖这些文件，但提交前仍应检查 `git status`。
