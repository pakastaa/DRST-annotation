# Security Policy

本仓库只保存可公开审查的网站代码，不保存 DRST 原始文本、模型输出、人工复核结果或任何认证材料。

提交前请确认不存在以下内容：

- `dataset/` 或 `outputs/` 下的实验文件；
- JSONL 样本与 SQLite 数据库；
- `users.json`、明文密码、session secret；
- TLS 私钥、证书或其他访问令牌。

若敏感信息被提交，不要只删除最新版本；应立即轮换凭据并清理 Git 历史。线上服务应继续使用 HTTPS，并限制操作系统层面的数据文件权限。

