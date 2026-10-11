# DRST Annotation Review

DRST-Bench 的轻量级模型标注复核网站。网页展示 Qwen3.6-27B 生成并经过规则筛选的状态转移候选，复核者只需判断候选应当保留、修改、存疑或排除，而不是从原始对话开始标注。

当前服务器入口：[https://121.48.161.104:8765](https://121.48.161.104:8765)

## 架构

- GitHub 私有仓库仅保存网站代码和部署模板。
- 原始文本、候选事件、SQLite 复核结果、账号密码和 TLS 证书只保存在实验服务器。
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

## 本地检查

网站后端仅使用 Python 标准库，前端为原生 HTML/CSS/JavaScript：

```bash
./scripts/validate_checkout.sh
```

更完整的复核方法、标签解释和导出说明见 [`DRST/bench_v1/annotation_web/README.md`](DRST/bench_v1/annotation_web/README.md)。

## 数据安全

不要向仓库提交 `dataset/`、`outputs/`、JSONL 样本、SQLite 数据库、`users.json`、初始密码或 TLS 私钥/证书。仓库的 `.gitignore` 已覆盖这些文件，但提交前仍应检查 `git status`。本仓库不使用 GitHub Pages，因为静态 Pages 无法安全运行登录、数据库写入和结果导出后端。

