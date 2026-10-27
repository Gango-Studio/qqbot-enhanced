# qqbot-enhanced

给 **DeepSeek Harness** 官方 QQ 机器人插件 [`@tencent-connect/dsh-qqbot`](https://www.npmjs.com/package/@tencent-connect/dsh-qqbot) 加三样东西：

1. **像真人一样说话** —— 回复拆成 1~3 条短消息、去掉 Markdown、发送前显示"正在输入"、按字数停顿
2. **会主动开口** —— 按时间和概率主动找你聊天，也可以自己预约"过 N 分钟后提一句"
3. **跨私聊/群聊的长期记忆** —— 私聊记下的事群里也记得；标为私密的只在私聊出现

它**不替换**官方插件：AppID、连接方式、会话、你写的 `directPrompt` / `groupPrompt` 全部原样，只在系统提示末尾追加表达习惯，并接管出站文本。

> 不是 Cordis 插件包，而是一层"安装器 + 运行时扩展"。原因见 [docs/DESIGN.md](docs/DESIGN.md#为什么是补丁而不是独立插件)。

## 功能清单

| 能力 | 状态 | 说明 |
|---|---|---|
| 拟人化发送 | ✅ | 去 Markdown、1~3 条气泡、C2C 正在输入、按字数停顿、可选标志表情 |
| 主动说话 | ✅ | 心跳调度（时段/间隔/每日额度/概率）+ `qq_follow_up` 预约；`<silent>` 静默 |
| 跨会话记忆 | ✅ | `shared` 私聊群聊互通，`private` 仅私聊；可 `memory.enabled=false` 关闭 |
| 记忆隔离 | ✅ | `scope`: `global`（一份）/ `per-peer`（完全隔离）/ `owner`（主人私聊+群共享，陌生人隔离） |
| 自动整理记忆 | ✅ | 每 N 轮对话自动叫醒模型整理 1~2 条事实，不用它"自觉"记 |
| 人设保留 | ✅ | 只在原 `directPrompt` / `groupPrompt` 之后追加表达习惯，不覆盖 |
| 出站内容保护 | ✅ | 审批/问答按钮、图片/文件、ark/embed 原样放行，只改写纯文本 |
| 安装与回滚 | ✅ | `install` / `--dry-run` / `--check` / `--restore`，锚点检测 + `.orig` 备份 |
| 离线测试 | ✅ | 14 项：拆条、Markdown、沉默、记忆共享与隐私过滤、三种隔离模式、自动整理、关闭记忆、非 QQ 会话不注入 |
| 语音 / 表情包 | ❌ | 只处理文本；语音、收藏表情不在范围内 |

## 效果

```
你：今天好累

官方 bot：今天辛苦了。建议早点休息，明天还有……
增强之后：
  （正在输入…）
  「咋了，加班到几点」
  （正在输入…）
  「先说好，累成这样别硬撑着刷手机」
```

```
[私聊] 你：我下周三要体检，提醒我别熬夜
       bot：记住了

[群聊] 你：@bot 我下周有啥事
       bot：下周三体检啊，你这几天不是老熬夜
```

## 安装

需要先装好官方插件：

```bash
npx @deepseek-ai/dsh plugin --profile desktop add @tencent-connect/dsh-qqbot
```

然后：

```bash
# 安装增强（默认 profile = desktop）
npx qqbot-enhanced

# 指定 profile
npx qqbot-enhanced --profile myprofile

# 先看看会改什么
npx qqbot-enhanced --dry-run

# 检查安装状态
npx qqbot-enhanced --check

# 卸载（还原 bootstrap.js）
npx qqbot-enhanced --restore
```

安装完成后**完全退出 DeepSeek Harness 再启动**（Node 的 ESM 缓存不会热更新 `dist/` 里的模块）。

安装器做的事：

| 文件 | 操作 |
|---|---|
| `.../dsh-qqbot/dist/persona.js` | 写入运行时扩展 |
| `.../dsh-qqbot/dist/gateway/bootstrap.js` | 插入 9 行加载钩子（`try/catch`，失败不影响 QQ 通道） |
| `.../dsh-qqbot/dist/gateway/bootstrap.js.orig` | 首次安装时的备份，用于回滚 |
| `~/.dsh/profiles/<profile>/qqbot-enhanced.json` | 默认配置（已存在则不覆盖） |

## 配置

所有字段都有默认值，文件不存在也能跑。改完保存即生效（发送相关的下一轮立即生效）。

```json
{
  "enabled": true,
  "humanize": {
    "enabled": true,
    "stripMarkdown": true,
    "maxBubbles": 3,
    "signatureEmoji": "",
    "typingIndicator": true,
    "baseDelayMs": [500, 1400],
    "perCharDelayMs": 16,
    "maxDelayMs": 2600
  },
  "proactive": {
    "enabled": true,
    "activeHours": [9, 23],
    "tickMinutes": 5,
    "minGapMinutes": 90,
    "maxPerDayPerPeer": 3,
    "probability": 0.55,
    "peersTtlDays": 7,
    "maxPeers": 5,
    "allowGroups": false
  },
  "memory": {
    "enabled": true,
    "scope": "global",
    "owners": [],
    "autoSummarize": { "enabled": true, "everyTurns": 12, "minGapMinutes": 60 }
  },
  "persona": { "stylePrompt": "" }
}
```

| 字段 | 说明 |
|---|---|
| `humanize.maxBubbles` | 一条回复最多拆成几条（受 QQ 单条消息 4 次被动回复额度限制，建议 ≤3） |
| `humanize.signatureEmoji` | 每个气泡自动补的标志表情，例如 `"✨"`；留空不补 |
| `humanize.stripMarkdown` | 去掉标题/列表/加粗/代码块（QQ 上 Markdown 会显示成乱码） |
| `proactive.activeHours` | 允许主动说话的时段 `[开始, 结束)`，24 小时制 |
| `proactive.minGapMinutes` | 两次主动说话的最小间隔 |
| `proactive.maxPerDayPerPeer` | 每人每天主动次数上限（QQ 主动消息有平台额度，别调太高） |
| `proactive.allowGroups` | 是否允许在群里主动说话（默认关闭，避免刷屏） |
| `persona.stylePrompt` | 覆盖内置的「说话方式」文本；留空用默认 |
| `memory.enabled` | 是否启用长期记忆（关闭后不注入、不注册记忆工具） |
| `memory.scope` | `global`（一份记忆）/ `per-peer`（每个会话独立）/ `owner`（主人私聊+群共享） |
| `memory.owners` | `scope=owner` 时，这些 c2c openid 视为主人 |
| `memory.autoSummarize.everyTurns` | 每 N 轮对话自动整理一次记忆 |
| `memory.autoSummarize.minGapMinutes` | 两次自动整理的最小间隔 |

## 主动说话怎么触发

两种：

- **心跳**：每 `tickMinutes` 检查一次；满足时段、间隔、每日额度，且距上次聊天 > 8 分钟时，按 `probability` 触发一次。触发时系统给模型一条以 `（内心时间` 开头的私人提醒，模型决定说或不说。
- **预约**：模型可以调用 `qq_follow_up(in_minutes, note)` 约一个"过 N 分钟提醒我"。到点同样给一次内心提示。

模型不想说话时输出 `<silent>`，这条消息会被拦截，用户看不到。

## 工具参考

增强会向模型注册 5 个工具（都是普通 DSH tool，可在会话里直接调用）：

| 工具 | 参数 | 作用 |
|---|---|---|
| `qq_say` | `text` | 立刻说一句（不经过被动回复额度，走主动推送） |
| `qq_follow_up` | `in_minutes`、`note` | 预约 N 分钟后提醒自己开口 |
| `qq_memory_write` | `text`、`visibility?` | 记一条长期事实 |
| `qq_memory_list` | — | 列出当前会话可见的记忆 |
| `qq_memory_forget` | `id?`、`text?` | 忘掉一条记忆 |

## 记忆

三个工具（模型自己调用，也可以让它"记住这个"）：

| 工具 | 作用 |
|---|---|
| `qq_memory_write` | 记一条事实，`visibility: shared`（默认）或 `private` |
| `qq_memory_list` | 列出当前会话可见的记忆 |
| `qq_memory_forget` | 按 id 或原文删除 |

**单向隐私规则**：`private` 条目只注入私聊，群里完全不出现；`shared` 两边都注入。

存储：`~/.dsh-qqbot/memory.json`，纯 JSON，可以直接编辑：

```json
{
  "facts": [
    { "id": "a1b2c3d4", "text": "称呼他「小明」", "visibility": "shared", "from": "c2c", "at": 1793100000000 }
  ]
}
```

上限 200 条、每条 200 字；注入时取最近 40 条，控制 token。

不需要记忆时把 `memory.enabled` 设为 `false`：不再注入记忆段落，也不注册三个记忆工具（重启后生效）。

**记忆隔离**：`memory.scope` 三档——

| scope | 谁能看到 | 适用 |
|---|---|---|
| `global`（默认） | 所有私聊和群共享一份 | 单人使用的私人机器人 |
| `owner` | `owners` 里的 openid 的私聊 + 所有群共享一份；其他人各自独立 | 自己用 + 自己的群，同时不想串给陌生人 |
| `per-peer` | 每个私聊/群各自独立，不互通 | 给多人用、或不想让群和私聊串 |

**自动整理**：`autoSummarize` 开着时，每 `everyTurns` 轮对话（且距上次超过 `minGapMinutes`）会叫醒模型一次：回看这段对话、用 `qq_memory_write` 记 1~2 条事实，然后静默。整理本身不计入轮数，不会递归触发。

### 数据文件

| 路径 | 内容 |
|---|---|
| `~/.dsh-qqbot/memory.json` | 长期事实（可手工编辑） |
| `~/.dsh-qqbot/persona-state.json` | 认识的人、预约、每日主动计数 |
| `~/.dsh-qqbot/persona.log` | 启动 / 发送 / 主动触发 / 记忆写入日志 |

## 兼容性

- Node.js ≥ 20.3
- `@tencent-connect/dsh-qqbot` ≥ 0.5.0（已验证 0.5.2）
- 支持 Windows / macOS / Linux（安装器只用 Node 内置模块）

**插件升级会覆盖补丁**。`dsh plugin update` 或重装插件后，重跑一次 `npx qqbot-enhanced` 即可；`.orig` 备份始终是首次安装时的原始文件，升级后若锚点变化，安装器会明确报错而不是写坏文件。

早期预览版用的是 `qq-persona` 名字（`[qq-persona]` 钩子 + `qq-persona.json` 配置）。安装器会自动识别旧钩子、迁移旧配置，不需要手工清理。

## 故障排查

| 现象 | 处理 |
|---|---|
| 重启后聊天没有变化 | `npx qqbot-enhanced --check` 确认 `extension` / `bootstrap` 都是 installed/patched；确认是真的退出了托盘进程 |
| 回复没拆条 | 看 `~/.dsh-qqbot/persona.log` 有没有 `sent` 记录；群聊默认不支持流式，但私聊若被外部强制开启 streaming，拆条会失效 |
| 主动说话不触发 | 默认只在 9:00–23:00、距上次聊天 8 分钟后、且概率命中时触发；先确认对方聊过至少一次（没有 openid 无法主动） |
| 记忆没生效 | 确认 `memory.json` 是否生成；`private` 记忆在群里本来就不该出现 |
| 想彻底恢复 | `npx qqbot-enhanced --restore`，然后重启 |

日志：`~/.dsh-qqbot/persona.log`（每次启动、发送、主动触发、记忆写入都会记一行）

## 开发

```bash
npm test        # 离线测试：拆条、Markdown 清理、沉默、记忆共享与隐私过滤
npm run check   # 检查本机安装状态
```

测试不需要 QQ 连接，也不需要 DSH 运行时：用假的 bot/manager/ctx 驱动模块。

## License

[MIT](LICENSE)
