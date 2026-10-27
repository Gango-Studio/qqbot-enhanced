# Changelog

## 0.2.0

- **记忆隔离**：`memory.scope` 支持 `global` / `owner` / `per-peer` 三档；事实带 `owner` 字段，旧数据自动按 `global` 兼容
- **自动整理记忆**：每 `everyTurns` 轮对话自动叫醒模型回顾并写 1~2 条事实；内部轮次不计数，避免递归触发
- **测试**：新增主人/陌生人隔离、per-peer 隔离、自动整理三组用例，共 14 项
- **文档**：README 增加隔离模式表与自动整理说明；DESIGN 补充 owner 归属与整理机制

## 0.1.0

首个可发布版本。

- **拟人化发送**：Markdown 清理、按句子/行切 1~3 条气泡、C2C 正在输入、按字数停顿
- **主动说话**：心跳调度（时段/间隔/每日额度/概率）+ `qq_follow_up` 预约；`<silent>` 静默
- **共享记忆**：`qq_memory_write` / `qq_memory_list` / `qq_memory_forget`，`shared` 私聊群聊共享、`private` 仅私聊
- **系统提示追加**：说话方式、记忆使用规则、当前可见事实（不覆盖用户原有 `directPrompt` / `groupPrompt`）
- **安装器**：`install` / `--dry-run` / `--check` / `--restore` / `--profile`，锚点检测、备份、幂等
- **测试**：离线 `node --test`，覆盖拆条、Markdown、沉默、记忆共享与隐私过滤
- **文档**：README 增加功能清单、工具参考、数据文件说明与多用户注意；DESIGN 补充记忆隔离与已知限制
- **配置**：新增 `memory.enabled` 开关（关闭后不注入记忆、不注册记忆工具）
