# 设计说明

## 目标与非目标

**目标**

- 让官方 QQ 机器人的回复更像真人：短气泡、无 Markdown、正在输入、自然停顿
- 允许机器人主动开口，但严格受时段、间隔、每日额度和概率约束
- 私聊与群聊共享同一份"关于用户的事实"，同时保证私密内容不进入群聊
- 不改变任何既有配置：AppID / Secret / 连接方式 / `directPrompt` / `groupPrompt`

**非目标**

- 不接管收消息（仍然由官方插件完成鉴权、下载媒体、建会话）
- 不替换模型、不改 preset、不注入额外系统提示之外的内容
- 不做多机器人编排、不做个人号（OneBot）桥接

## 为什么是补丁而不是独立插件

DSH 的插件通过 Cordis 上下文协作，但 `@tencent-connect/dsh-qqbot` **没有暴露任何服务**：`QQBot` 实例、`SessionManager`、出站 `sender` 全都活在 `bootstrapGateway()` 的闭包里。

独立插件要做到同样的事，只有两条路：

1. 用相同 `appId` 再建一个 `QQBot` 连接 —— 同一个机器人两条 WebSocket 会互相挤下线，且消息可能重复投递
2. 自己实现一整套收发出站 —— 等于把官方插件重写一遍

所以选择**安装期注入**：在 `bootstrap.js` 的网关装配末尾插一段 9 行钩子，把内部对象交给扩展模块。钩子被 `try/catch` 包住，扩展加载失败时官方插件照常工作。

```js
// dist/gateway/bootstrap.js
registerSendFileTool(ctx, mediaSender, manager, config, logger);

// ── [qqbot-enhanced] ... ──
try {
    const enhanced = await import('../persona.js');
    await enhanced.installPersona({ ctx, bot, sender, manager, config, logger });
}
catch (err) {
    logger.error(`[qqbot-enhanced] failed to load: ...`);
}
```

**代价**是插件升级会覆盖补丁。安装器为此做了三件事：首次安装备份 `bootstrap.js.orig`、用锚点正则定位注入点（找不到就报错而不是写坏文件）、提供 `--restore`。

## 数据流

```
QQ 用户 ──WS──▶ 官方插件 ──▶ agent.followup() ──▶ DSH agent ──▶ LLM
                    │                                      │
                    │                              assistant/message
                    ▼                                      ▼
              SessionManager                        OutboundRouter
                    │                                      │
                    │                       sender.sendMarkdown(target, text)
                    │                                      ▼
                    └──────────────▶  bot.send()（被扩展接管）
                                                   │
                                      去 Markdown → 切气泡 → 正在输入 → 停顿
                                                   ▼
                                             QQ 消息（1~3 条）
```

扩展只在最底层的 `bot.send` 拦截**纯文本**；带 `keyboard` 的审批/问答按钮、图片/文件、ark/embed 全部原样放行。

## 三个子系统

### 1. humanize —— 出站改写

- 包装 `bot.send`：`markdown` 且无键盘时，改走 `humanSend()`
- 去 Markdown：标题/列表/加粗/行内代码/代码块围栏/引用/分隔线
- 切气泡：段落 → 行 → 句子，按总字数决定 1~3 条；换行在必要时保留
- 正在输入：C2C 调用 `sendTyping(target, 30)`，失败静默
- 停顿：`baseDelay + 每字延迟`，上限 `maxDelayMs`
- 顺带把 `config.streaming` 置为 `false`；若配置对象被冻结，则让 `openStream` 降级，走静态发送路径

### 2. prompt —— 系统提示追加

`system-prompt/assemble` 是 waterfall 事件，`SessionManager` 自己也用它注入 `directPrompt`。扩展追加三段（**都在原有内容之后**）：

| section | 内容 |
|---|---|
| `qq-persona:style` | 说话方式（短句、不用 Markdown、可以主动开口） |
| `qq-persona:memory-guide` | 记忆工具的使用规则与隐私约定 |
| `qq-persona:memory` | 当前对话可见的事实清单（有记忆时才注入） |

身份、称呼、口头禅仍然由用户的 `directPrompt` / `groupPrompt` 决定，style 段开头就声明"以原设定为准"。

### 3. proactive —— 主动说话

- 每 `tickMinutes` 跑一次 tick，用 `ctx.effect` 挂载，插件卸载时清理
- 先处理到点的 `qq_follow_up` 预约，再考虑心跳
- 心跳候选：最近 `peersTtlDays` 天内聊过、未超当日额度、距上次聊天 > 8 分钟、距上次主动 > `minGapMinutes`
- 触发时把该会话的 `replyTarget` 清掉 `msgId`（旧 `msg_id` 已过期），再 `agent.followup()` 一条「内心时间」提示
- 模型输出 `<silent>` 时，`humanSend` 直接丢弃
- 每轮最多叫醒一个人，避免同时骚扰

## 记忆模型

```json
{
  "facts": [
    { "id": "a1b2c3d4", "text": "称呼他「猪猪」", "visibility": "shared", "from": "c2c", "at": 1793100000000 }
  ],
  "updatedAt": 1793100000000
}
```

- 写入：去重（同文更新 `at`）、限长 200 字、总量 200 条（超出淘汰最旧）
- 读取：按会话 scope 过滤 —— `group` 只拿 `shared`，`c2c` 拿全部
- 注入：最近 40 条，每条带日期，`private` 标记「仅私聊」
- 落盘：先写 `.tmp` 再 `rename`，避免半截 JSON

隐私模型是**单向**的：私聊里标了 `private` 的内容永远不进群聊；群里说的 `shared` 事实会进私聊。这个方向由 `memorySection(scope)` 一处实现，没有第二条路径。

**隔离**：每条事实带 `owner` 字段，由 `memory.scope` 决定归属：

| scope | owner 取值 | 效果 |
|---|---|---|
| `global`（默认） | `global` | 一个 bot 一份记忆，所有会话共享 |
| `per-peer` | `<scope>:<peerId>` | 私聊、群各自独立，永不互通 |
| `owner` | 主人 → `owner`；其他人 → `peer:<openid>` | 主人私聊与所有群共享；陌生人各自独立 |

旧数据没有 `owner` 字段时按 `global` 处理，升级不清空。

**自动整理**：`memory.autoSummarize` 在 `session/event` 的 `turn/end` 上计数，达到 `everyTurns` 且超过 `minGapMinutes` 时，用 `wakeAgent()` 给会话发一条「记忆整理时间」提示，让模型回看对话并最多写 2 条事实，最后 `<silent>`。整理轮次记在 `internalTurns` 集合里，结束时不计入轮数，避免自我递归。

## 平台限制

- QQ 对**被动回复**（带 `msg_id`）有每条消息 4 次的上限，插件自带 `ReplyLimiter`；气泡数默认 ≤3 留出余量
- **主动消息**有平台额度，扩展默认每人每天 ≤3 条、间隔 ≥90 分钟，同时受时段限制
- 群聊不启用流式消息，私聊的流式会被扩展关掉
- 机器人在群里默认需要被 @ 才收到消息（官方插件 `requireMention` 默认 `true`）

## 安全

- 不读取、不写入任何凭据；安装器只碰 `dist/` 和 profile 下的配置文件
- 无网络请求；所有数据都在 `~/.dsh-qqbot/` 本地
- 工具只暴露给模型会话，且 `qq-chat-v2` 之类的 preset 可以用工具白名单进一步收窄

## 已知限制

- 插件升级需要重跑安装器
- `persona.js` 依赖官方插件 `dist/` 的内部结构（`bot.send`、`system-prompt/assemble`、`SessionManager` 的 `findByAgent`），大版本升级后需要重新验证
- 主动说话需要对方至少聊过一次（否则拿不到 openid）
- 记忆是"写下来的事实"，不是完整聊天记录；跨会话不共享原始对话
- 自动整理靠模型自觉：它可能判断"没什么可记的"而什么都不写
- 语音、收藏表情、图片理解不在范围内（只处理文本出站）
