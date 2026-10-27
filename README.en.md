# qqbot-enhanced (English)

Enhancement layer for the official QQ bot plugin of **DeepSeek Harness**
([`@tencent-connect/dsh-qqbot`](https://www.npmjs.com/package/@tencent-connect/dsh-qqbot)):

- **Human-like replies** — strip Markdown, split into 1–3 short bubbles, show a typing indicator, pause proportional to length
- **Proactive talking** — optional heartbeat plus a `qq_follow_up` tool so the bot can come back to you later; `<silent>` suppresses a message
- **Shared long-term memory** — facts learned in a private chat are visible in groups and vice versa; `private` facts never leak into groups; `memory.scope` supports `global` / `owner` / `per-peer` isolation
- **Automatic memory curation** — every N turns the bot revisits the conversation and records 1–2 facts by itself

It does **not** replace the official plugin: AppID, connection, sessions and your own
`directPrompt` / `groupPrompt` stay untouched. The extension only appends an
expression-style section to the system prompt and rewrites outbound text.

## Install

```bash
npx @deepseek-ai/dsh plugin --profile desktop add @tencent-connect/dsh-qqbot
npx qqbot-enhanced              # patch the profile
npx qqbot-enhanced --check      # status
npx qqbot-enhanced --restore    # uninstall
```

Restart DeepSeek Harness after installing (ESM caches `dist/` modules).

## Why a patch?

The official plugin exposes no Cordis service: the `QQBot` instance, `SessionManager`
and outbound sender live inside `bootstrapGateway()`. A separate plugin would either
open a second WebSocket for the same AppID (the platform kicks one out) or reimplement
the whole channel. The installer therefore injects a 9-line try/catch hook into
`dist/gateway/bootstrap.js` and ships a backup for rollback. See
[docs/DESIGN.md](docs/DESIGN.md) for the full rationale.

## Runtime data

- `~/.dsh-qqbot/memory.json` — long-term facts
- `~/.dsh-qqbot/persona.log` — install/send/proactive/memory log
- `~/.dsh-qqbot/persona-state.json` — known peers, follow-up plans, daily counters

## License

MIT
