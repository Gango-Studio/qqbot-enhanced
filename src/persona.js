/**
 * qqbot-enhanced — human-like chatting, proactive talking and shared long-term
 * memory for the official QQ bot plugin (@tencent-connect/dsh-qqbot) of
 * DeepSeek Harness.
 *
 * Design rules (see docs/DESIGN.md):
 *   - Enhance, never replace. Same AppID, same WebSocket, same sessions.
 *   - `directPrompt` / `groupPrompt` are left untouched; we only append an
 *     expression-style section after them, explicitly deferring to your own
 *     persona text.
 *   - Outbound text is the only thing we rewrite: strip Markdown, split into
 *     1-3 short bubbles, show a typing indicator and wait like a human.
 *   - Proactive messages reuse the same agent session; platform quota is the
 *     hard limit and we stay well below it.
 *
 * Loaded by dist/gateway/bootstrap.js right after the gateway is wired up.
 * The integrator injects { ctx, bot, sender, manager, config, logger }.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, randomInt } from 'node:crypto';

const PROFILE_DIR = process.env.DSH_PROFILE_DIR || join(homedir(), '.dsh', 'profiles', 'desktop');
/** Runtime data lives next to the official plugin's media dir. */
const RUNTIME_DIR = process.env.QQBOT_ENHANCED_HOME || join(homedir(), '.dsh-qqbot');
const CONFIG_PATH = join(PROFILE_DIR, 'qqbot-enhanced.json');
/** Backwards compatible with the pre-release name. */
const LEGACY_CONFIG_PATH = join(PROFILE_DIR, 'qq-persona.json');
const STATE_PATH = join(RUNTIME_DIR, 'persona-state.json');
const MEMORY_PATH = join(RUNTIME_DIR, 'memory.json');
const LOG_PATH = join(RUNTIME_DIR, 'persona.log');

/** Reported in persona.log so you can tell which build is actually loaded. */
const VERSION = '0.2.0';

const SILENT_TOKENS = ['<silent>', '<沉默>', '[silent]', '<pass>'];
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

/**
 * 追加到系统提示末尾的「说话方式」。
 * 注意：这里不设定身份、不设定名字 —— 身份由 directPrompt / groupPrompt 决定。
 */
const STYLE_PROMPT = [
  '【说话方式｜只影响怎么打字，不改变你是谁】',
  '上面给你的身份、称呼、口头禅、固定表情全部保持不变，下面只规定聊天时的表达习惯：',
  '- 像真人在 QQ 上打字：短句，一两句一条，最多两三条。不要写长段落。',
  '- 不用 Markdown：不要标题、列表、加粗、表格、代码块（对方明确要代码时除外）。',
  '- 保留你的标志性称呼和表情，但别每句都用同一个句式。',
  '- 少用感叹号，别堆书面语。口语化一点，「嗯」「诶」「行」「哈哈」可以用，但别刻意。',
  '- 不要每次都以问句结尾，也不要复读对方说过的话。',
  '- 不说「作为一个 AI / 语言模型」，不解释自己在扮演谁。',
  '- 不知道就说不知道，别编。',
  '- 有时间感：知道现在几点，深夜别硬聊。',
  '- 你被允许主动开口：收到以「（内心时间」开头的消息时，那不是对方说的话，是系统给你的私人提醒。想找 TA 聊就自然地说 1~2 句；不想打扰就只输出 <silent>，系统会把这条消息拦下来，对方看不到。',
].join('\n');

/**
 * 长期记忆的使用说明（追加在系统提示里）。
 * 记忆跨私聊与群聊共享，但 private 条目只在私聊注入 —— 这就是单向隐私规则。
 */
const MEMORY_GUIDE = [
  '【长期记忆｜跨私聊与群聊】',
  '你有一份跨对话的长期记忆，私聊和群聊都能看到同一份事实。工具：qq_memory_write（记一条）、qq_memory_list（看全部）、qq_memory_forget（忘掉一条）。',
  `- 值得记：TA 的称呼/昵称、喜好与雷区、重要近况（工作、学习、健康、感情）、你们之间的约定和计划、TA 明确说过「记住」的事。`,
  '- 不值得记：正在进行的闲聊过程、一次性的临时信息、别人的隐私、你自己说过的话。不要每轮都写，一次对话最多记一两条真正有用的。',
  '- 敏感、私密、或 TA 说过「别告诉别人」的内容：写的时候传 visibility="private"，它只在私聊里出现，不会进群聊。其余默认 shared。',
  '- 记忆是事实，不是台词。提起时自然带出来，不要逐条复述，也不要说「根据我的记忆」。',
].join('\n');

const DEFAULT_CONFIG = {
  enabled: true,
  humanize: {
    enabled: true,
    stripMarkdown: true,
    maxBubbles: 3,
    signatureEmoji: '',
    typingIndicator: true,
    baseDelayMs: [500, 1400],
    perCharDelayMs: 16,
    maxDelayMs: 2600,
  },
  proactive: {
    enabled: true,
    activeHours: [9, 23],
    tickMinutes: 5,
    minGapMinutes: 90,
    maxPerDayPerPeer: 3,
    probability: 0.55,
    peersTtlDays: 7,
    maxPeers: 5,
    allowGroups: false,
  },
  memory: {
    enabled: true,
    /** global：一个 bot 一份记忆；per-peer：每个会话独立；owner：主人私聊+群共享 */
    scope: 'global',
    /** scope=owner 时，这些 c2c openid 视为主人 */
    owners: [],
    autoSummarize: {
      enabled: true,
      everyTurns: 12,
      minGapMinutes: 60,
    },
  },
};

// ── 日志 ────────────────────────────────────────────────────────────────
function log(...parts) {
  const line = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  try {
    mkdirSync(RUNTIME_DIR, { recursive: true });
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* 日志失败不影响主流程 */
  }
}

// ── 配置 ────────────────────────────────────────────────────────────────
function deepMerge(base, patch) {
  if (patch === null || patch === undefined) return base;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return patch;
  if (typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = deepMerge(base[k], v);
  return out;
}

let cachedConfig;
let cachedMtime = 0;
function configFile() {
  if (existsSync(CONFIG_PATH)) return CONFIG_PATH;
  if (existsSync(LEGACY_CONFIG_PATH)) return LEGACY_CONFIG_PATH;
  return undefined;
}
function loadConfig() {
  try {
    const file = configFile();
    if (!file) return cachedConfig ?? deepMerge(DEFAULT_CONFIG, {});
    const mtime = statSync(file).mtimeMs;
    if (cachedConfig && mtime === cachedMtime) return cachedConfig;
    cachedConfig = deepMerge(DEFAULT_CONFIG, JSON.parse(readFileSync(file, 'utf8')));
    cachedMtime = mtime;
    return cachedConfig;
  } catch (err) {
    log('config load failed, using previous/defaults:', String(err));
    return cachedConfig ?? deepMerge(DEFAULT_CONFIG, {});
  }
}

// ── 状态（认识的人、预约、计数） ────────────────────────────────────────
function loadState() {
  try {
    if (existsSync(STATE_PATH)) {
      const s = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
      return { peers: s.peers ?? {}, plans: Array.isArray(s.plans) ? s.plans : [] };
    }
  } catch (err) {
    log('state load failed:', String(err));
  }
  return { peers: {}, plans: [] };
}

function createStore() {
  const state = loadState();
  let timer;
  const persist = () => {
    try {
      mkdirSync(RUNTIME_DIR, { recursive: true });
      writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
    } catch (err) {
      log('state save failed:', String(err));
    }
  };
  return {
    state,
    persist,
    schedulePersist() {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        persist();
      }, 800);
      timer.unref?.();
    },
  };
}

// ── 长期记忆（私聊 / 群聊共享，可按人隔离） ───────────────────────────
/**
 * 存储结构：
 *   { facts: [{ id, text, visibility: 'shared'|'private', from, owner, at }], updatedAt }
 *
 * owner 决定"谁能看到"：
 *   global     → 'global'（默认：一个 bot 一份记忆，所有会话共享）
 *   per-peer   → 'c2c:<openid>' / 'group:<openid>'（完全隔离，DM 与群不互通）
 *   owner      → 主人（memory.owners 里的 c2c openid）的私聊与所有群共享 'owner'；
 *                其他人各自 'peer:<openid>'，彼此不可见
 *
 * private 只注入 c2c —— 单向隐私规则；旧数据没有 owner 字段时按 'global' 处理。
 */
function memoryMode() {
  const mode = loadConfig().memory?.scope;
  return mode === 'owner' || mode === 'per-peer' ? mode : 'global';
}

function ownerKeyFor(scope, peerId) {
  const mode = memoryMode();
  if (mode === 'global') return 'global';
  if (mode === 'per-peer') return `${scope}:${peerId ?? 'unknown'}`;
  const owners = loadConfig().memory?.owners;
  if (scope === 'group') return 'owner';
  return Array.isArray(owners) && owners.includes(peerId) ? 'owner' : `peer:${peerId ?? 'unknown'}`;
}

const factOwner = (f) => f.owner ?? 'global';

function loadMemory() {
  try {
    if (existsSync(MEMORY_PATH)) {
      const m = JSON.parse(readFileSync(MEMORY_PATH, 'utf8'));
      if (Array.isArray(m?.facts)) return m;
    }
  } catch (err) {
    log('memory load failed, start empty:', String(err));
  }
  return { facts: [], updatedAt: 0 };
}

function saveMemory(mem) {
  try {
    mkdirSync(RUNTIME_DIR, { recursive: true });
    mem.updatedAt = Date.now();
    // 先写临时文件再 rename，避免半截 JSON
    const tmp = `${MEMORY_PATH}.tmp`;
    writeFileSync(tmp, JSON.stringify(mem, null, 2), 'utf8');
    renameSync(tmp, MEMORY_PATH);
  } catch (err) {
    log('memory save failed:', String(err));
  }
}

const MAX_FACTS = 200;
const MAX_FACT_CHARS = 200;

function addFact({ text, visibility, from, owner }) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_FACT_CHARS);
  if (!clean) throw new Error('记忆内容不能为空');
  const bucket = owner ?? 'global';
  const mem = loadMemory();
  const existing = mem.facts.find((f) => f.text === clean && factOwner(f) === bucket);
  if (existing) {
    existing.at = Date.now();
    existing.from = from ?? existing.from;
    if (visibility) existing.visibility = visibility;
    saveMemory(mem);
    return existing;
  }
  const fact = {
    id: randomUUID().slice(0, 8),
    text: clean,
    visibility: visibility === 'private' ? 'private' : 'shared',
    from: from ?? 'c2c',
    owner: bucket,
    at: Date.now(),
  };
  mem.facts.push(fact);
  if (mem.facts.length > MAX_FACTS) mem.facts = mem.facts.slice(-MAX_FACTS);
  saveMemory(mem);
  return fact;
}

/** 某个会话能看到的记忆；群聊只拿 shared */
function visibleFacts(scope, peerId) {
  const key = ownerKeyFor(scope, peerId);
  return loadMemory().facts
    .filter((f) => factOwner(f) === key)
    .filter((f) => (scope === 'group' ? f.visibility !== 'private' : true));
}

function memorySection(scope, peerId) {
  const visible = visibleFacts(scope, peerId);
  if (visible.length === 0) return undefined;
  const lines = visible.slice(-40).map((f) => {
    const d = new Date(f.at);
    const day = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
    const tag = f.visibility === 'private' ? '，仅私聊' : '';
    return `- ${f.text}（${day}${tag}）`;
  });
  return ['【长期记忆｜你和 TA 之间的事实】', ...lines, '（自然提到即可，不要逐条复述，也不要说「根据我的记忆」。）'].join('\n');
}

function listFacts(scope, peerId) {
  return visibleFacts(scope, peerId).slice(-100);
}

function forgetFact({ id, text, owner }) {
  const mem = loadMemory();
  const before = mem.facts.length;
  mem.facts = mem.facts.filter((f) => {
    if (factOwner(f) !== (owner ?? 'global')) return true;
    if (id) return f.id !== String(id);
    return f.text !== String(text ?? '').trim();
  });
  if (mem.facts.length !== before) saveMemory(mem);
  return before - mem.facts.length;
}

/** 注册记忆工具；`memory.enabled=false` 时不注册 */
function registerMemoryTools(tools, manager) {
  const currentPeer = (exec) => {
    const record = exec?.agent ? manager.findByAgent(exec.agent) : undefined;
    return { scope: record?.scope ?? 'c2c', peerId: record?.peerId };
  };
  tools.register({
    name: 'qq_memory_write',
    description:
      'Remember one long-term fact about this person (nickname, likes/dislikes, important life updates, '
      + 'promises and plans). Facts are shared between the private chat and group chats. '
      + 'Pass visibility="private" for sensitive things — private facts are only visible in the private chat, never in groups.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The fact, one short sentence, max 200 characters.' },
        visibility: {
          type: 'string',
          enum: ['shared', 'private'],
          description: 'shared = visible everywhere (default); private = only in the private chat.',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, id: { type: 'string' }, visibility: { type: 'string' } },
        required: ['ok'],
        additionalProperties: false,
      },
      render: (_a, v) => [{ type: 'text', text: v?.ok ? '记住了' : '没记住' }],
    },
    async execute(args, exec) {
      const { scope, peerId } = currentPeer(exec);
      const fact = addFact({ text: args?.text, visibility: args?.visibility, from: scope, owner: ownerKeyFor(scope, peerId) });
      log(`memory + [${fact.visibility}] ${fact.text}`);
      return { ok: true, id: fact.id, visibility: fact.visibility };
    },
  });

  tools.register({
    name: 'qq_memory_list',
    description: 'List the long-term facts you remember about this person (private facts only show up in the private chat).',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: { count: { type: 'integer' }, facts: { type: 'array', items: { type: 'string' } } },
        required: ['count'],
        additionalProperties: false,
      },
      render: (_a, v) => {
        if (!v?.count) return [{ type: 'text', text: '还没有记忆' }];
        return [{ type: 'text', text: v.facts.join('\n') }];
      },
    },
    async execute(_args, exec) {
      const { scope, peerId } = currentPeer(exec);
      const facts = listFacts(scope, peerId);
      return { count: facts.length, facts: facts.map((f) => `[${f.id}] ${f.text}${f.visibility === 'private' ? '（仅私聊）' : ''}`) };
    },
  });

  tools.register({
    name: 'qq_memory_forget',
    description: 'Forget one long-term fact, by id (from qq_memory_list) or by exact text.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Fact id from qq_memory_list.' },
        text: { type: 'string', description: 'Exact fact text to remove.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { removed: { type: 'integer' } }, required: ['removed'], additionalProperties: false },
      render: (_a, v) => [{ type: 'text', text: v?.removed ? `忘掉了 ${v.removed} 条` : '没找到这条记忆' }],
    },
    async execute(args, exec) {
      const { scope, peerId } = currentPeer(exec);
      const removed = forgetFact({ id: args?.id, text: args?.text, owner: ownerKeyFor(scope, peerId) });
      if (removed) log(`memory - ${removed}`);
      return { removed };
    },
  });
}

// ── 文本处理 ────────────────────────────────────────────────────────────
function isSilent(text) {
  const t = (text ?? '').trim().toLowerCase();
  if (!t) return true;
  return SILENT_TOKENS.some((token) => t === token.toLowerCase());
}

/** 去掉 Markdown 记号，留下真人会打的字（emoji 原样保留） */
function stripMarkdown(input) {
  let t = input;
  t = t.replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, '$1');
  t = t.replace(/`([^`]+)`/g, '$1');
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 $2');
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  t = t.replace(/^\s{0,3}>\s?/gm, '');
  t = t.replace(/^\s*[-*+]\s+/gm, '');
  t = t.replace(/^\s*\d+[.、]\s+/gm, '');
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1');
  t = t.replace(/__([^_]+)__/g, '$1');
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2');
  t = t.replace(/(^|[^_])_([^_\n]+)_/g, '$1$2');
  t = t.replace(/~~([^~]+)~~/g, '$1');
  t = t.replace(/^\s*([-*_]\s*){3,}$/gm, '');
  t = t.replace(/[ \t]+$/gm, '');
  return t.trim();
}

/** 切成 1~max 条消息：按段落/行/句切最小单元，再按目标条数合并 */
function splitBubbles(text, max) {
  const clean = text.replace(/\r/g, '').trim();
  if (!clean) return [];

  // 1) 最小单元：段落 → 行 → 句子（记录「是否行首」，合并时决定要不要换行）
  const units = [];
  for (const para of clean.split(/\n{2,}/)) {
    for (const line of para.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      const sentences = t.match(/[^。！？!?…]+[。！？!?…]*/g) ?? [t];
      let first = true;
      for (const s of sentences) {
        const v = s.trim();
        if (!v) continue;
        units.push({ text: v, newLine: first });
        first = false;
      }
    }
  }
  if (units.length <= 1) return units.map((u) => u.text);

  const total = units.reduce((n, u) => n + u.text.length, 0);
  const target = total <= 28 ? 1 : total <= 90 ? 2 : Math.min(3, max);
  const appendUnit = (cur, u) => {
    if (!cur) return u.text;
    if (u.newLine && !/[。！？!?…；;：:，,]$/.test(cur)) return `${cur}\n${u.text}`;
    return cur + u.text;
  };
  if (target <= 1) return [units.reduce((cur, u) => appendUnit(cur, u), '')];

  const per = Math.ceil(total / target);
  const out = [];
  let cur = '';
  for (const u of units) {
    if (cur && cur.length + u.text.length > per && out.length < target - 1) {
      out.push(cur);
      cur = u.text;
      continue;
    }
    cur = appendUnit(cur, u);
  }
  if (cur) out.push(cur);
  return out.slice(0, Math.max(1, max));
}

/** 每条消息都带上人设里的标志表情（避免拆条后只有最后一条有标志表情） */
function applySignature(bubbles, emoji) {
  if (!emoji) return bubbles;
  return bubbles.map((b) => (b.includes(emoji) ? b : `${b}${emoji}`));
}

function thinkingDelay(text, humanize) {
  const [lo, hi] = humanize.baseDelayMs ?? [500, 1400];
  const base = randomInt(lo, Math.max(lo + 1, hi));
  const perChar = (humanize.perCharDelayMs ?? 16) * Math.min(text.length, 120);
  return Math.min(base + perChar, humanize.maxDelayMs ?? 2600);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── 主动说话的提示词 ────────────────────────────────────────────────────
function timeText(ts = Date.now()) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function gapText(ms) {
  if (!ms || ms < 0) return '有一会儿';
  const minutes = Math.round(ms / MINUTE);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.round(hours / 24)} 天`;
}

function heartbeatPrompt(peer) {
  return [
    `（内心时间 ${timeText()}，距上次和 TA 说话大约 ${gapText(Date.now() - (peer.lastSeen ?? 0))}）`,
    '你现在可以主动找 TA 说点什么，也可以不说。',
    '想聊就直接说你想说的 1~2 句，别问「在吗」，也别解释这是主动消息；不想打扰就只输出 <silent>。',
  ].join('\n');
}

function planPrompt(plan) {
  return [
    `（内心时间 ${timeText()}）`,
    `你之前记着要在现在做这件事：${plan.note}`,
    '想说就说，像平时那样 1~2 句；不想说就只输出 <silent>。',
  ].join('\n');
}

function summaryPrompt() {
  return [
    '（系统·记忆整理时间，这条不是 TA 说的话）',
    '回顾刚才这段对话：有哪些关于 TA 的、以后还用得上的事实？（称呼、喜好、近况、约定）',
    '最多用 qq_memory_write 记 2 条，敏感内容带 visibility="private"；没有值得记的就别调用。',
    '整理完不要对 TA 说话，只输出 <silent>。',
  ].join('\n');
}

// ── 时间与配额 ──────────────────────────────────────────────────────────
function inActiveHours(proactive, now = new Date()) {
  const [start, end] = proactive.activeHours ?? [9, 23];
  const h = now.getHours() + now.getMinutes() / 60;
  return h >= start && h < end;
}

function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── 主入口 ──────────────────────────────────────────────────────────────
const installedContexts = new WeakSet();

export async function installPersona({ ctx, bot, sender, manager, config, logger }) {
  if (!ctx || installedContexts.has(ctx)) return;
  installedContexts.add(ctx);

  const cfg0 = loadConfig();
  if (cfg0.enabled === false) {
    log('persona disabled by config');
    return;
  }

  const store = createStore();
  const memoryEnabled = cfg0.memory?.enabled !== false;

  // ── 0. 关闭 c2c 流式（否则回复是「同一条消息不断改写」，无法拆成人话气泡） ──
  try {
    config.streaming = false;
  } catch (err) {
    log('cannot mutate config.streaming:', String(err));
  }
  if (config.streaming !== false) {
    // 配置对象被冻结时的兜底：让流式写入永远降级为静态发送（这样会走 sendMarkdown → 拟人化）
    bot.openStream = () => {
      throw new Error('qq-persona: streaming disabled for human-like bubbles');
    };
    log('streaming fallback installed (openStream throws)');
  }

  // ── 1. 系统提示：追加「说话方式」，不动 directPrompt / groupPrompt ──
  const stylePrompt = cfg0.persona?.stylePrompt || STYLE_PROMPT;
  const onAssemble = async (_assembly, context, next) => {
    const assembled = await next();
    if (!context.agent) return assembled;
    const record = manager.findByAgent(context.agent);
    if (!record) return assembled; // 只作用于 QQ 会话
    const sections = [...(assembled.sections ?? []), { name: 'qq-persona:style', order: 95, text: stylePrompt }];
    if (memoryEnabled) {
      sections.push({ name: 'qq-persona:memory-guide', order: 96, text: MEMORY_GUIDE });
      const memText = memorySection(record.scope, record.peerId);
      if (memText) sections.push({ name: 'qq-persona:memory', order: 97, text: memText });
    }
    return { ...assembled, sections };
  };
  ctx.on('system-prompt/assemble', onAssemble);

  // ── 2. 拟人化发送：接管 bot.send，把 markdown 换成口语短消息 ──
  const originalSend = bot.send.bind(bot);
  const originalSendTyping = typeof bot.sendTyping === 'function' ? bot.sendTyping.bind(bot) : undefined;

  async function humanSend(target, rawText, opts = {}) {
    const cfg = loadConfig();
    const humanize = cfg.humanize ?? {};
    if (!humanize.enabled) return originalSend({ target, markdown: { content: rawText }, ...opts });

    let text = rawText ?? '';
    if (humanize.stripMarkdown !== false) text = stripMarkdown(text);
    if (isSilent(text)) {
      log(`silent skip → ${target.scope}:${target.targetId}`);
      return undefined;
    }
    if (opts.keyboard) {
      return originalSend({ target, markdown: { content: text }, ...opts });
    }

    let bubbles = splitBubbles(text, Math.max(1, humanize.maxBubbles ?? 3));
    bubbles = applySignature(bubbles, humanize.signatureEmoji ?? '');
    if (bubbles.length === 0) return undefined;

    let last;
    for (let i = 0; i < bubbles.length; i += 1) {
      const bubble = bubbles[i];
      if (humanize.typingIndicator && originalSendTyping && target.scope === 'c2c') {
        try {
          void originalSendTyping(target, 30).catch(() => {});
        } catch {
          /* 输入中提示失败无所谓 */
        }
      }
      await sleep(thinkingDelay(bubble, humanize));
      last = await originalSend({ target, content: bubble, ...(opts.extra ? { extra: opts.extra } : {}) });
      log(`sent ${i + 1}/${bubbles.length} (${bubble.length} 字) → ${target.scope}:${target.targetId}`);
    }
    return last;
  }

  bot.send = async function patchedSend(opts) {
    try {
      if (!opts || !opts.markdown || opts.keyboard || opts.media || opts.ark || opts.embed) {
        return await originalSend(opts);
      }
      if (!opts.markdown.content || !String(opts.markdown.content).trim()) return undefined;
      return await humanSend(opts.target, opts.markdown.content, opts);
    } catch (err) {
      log('patched send fallback:', String(err));
      return originalSend(opts);
    }
  };

  // ── 3. 记住聊过的人 ──
  function upsertPeer(record) {
    if (!record?.peerId) return;
    if (record.scope === 'group' && !(loadConfig().proactive?.allowGroups ?? false)) return;
    const key = `${record.scope}:${record.peerId}`;
    const prev = store.state.peers[key];
    store.state.peers[key] = {
      scope: record.scope,
      peerId: record.peerId,
      senderId: record.senderId ?? prev?.senderId ?? '',
      lastSeen: Date.now(),
      lastProactive: prev?.lastProactive ?? 0,
      proactiveDay: prev?.proactiveDay ?? '',
      proactiveCount: prev?.proactiveCount ?? 0,
    };
    store.schedulePersist();
  }

  function rememberFromManager() {
    for (const record of manager.sessions.values()) upsertPeer(record);
  }

  // 内部轮次（心跳 / 预约 / 整理记忆）不计入"对话轮数"，避免整理触发整理
  const internalTurns = new Set();
  const turnCounters = new Map();

  ctx.on('session/event', (session, event) => {
    try {
      const sessionId = session.header.id;
      const record = manager.findBySessionId(sessionId);
      if (!record) return;

      if (event?.type === 'user/message') {
        upsertPeer(record);
        return;
      }
      if (event?.type !== 'turn/end') return;

      if (internalTurns.has(sessionId)) {
        internalTurns.delete(sessionId);
        return;
      }

      const auto = loadConfig().memory?.autoSummarize;
      if (!memoryEnabled || auto?.enabled === false) return;
      const everyTurns = Math.max(2, Number(auto?.everyTurns ?? 12));
      const minGap = Math.max(0, Number(auto?.minGapMinutes ?? 60)) * MINUTE;

      const now = Date.now();
      const counter = turnCounters.get(sessionId) ?? { count: 0, lastAt: 0 };
      counter.count += 1;
      if (counter.count < everyTurns || now - counter.lastAt < minGap) {
        turnCounters.set(sessionId, counter);
        return;
      }
      turnCounters.set(sessionId, { count: 0, lastAt: now });
      void wakeAgent(record, summaryPrompt()).catch((err) => log('memory summarize failed:', String(err)));
    } catch (err) {
      log('session/event hook failed:', String(err));
    }
  });

  // ── 4. 叫醒会话，让它自己决定说不说 ──
  let createUserMessageFn;
  async function getCreateUserMessage() {
    if (createUserMessageFn) return createUserMessageFn;
    try {
      const mod = await import('@deepseek-ai/dsh-llm');
      createUserMessageFn = mod.createUserMessage;
    } catch (err) {
      log('dsh-llm import failed, fallback to plain message:', String(err));
      createUserMessageFn = (input) => ({ id: randomUUID(), role: 'user', content: input.content, source: input.source ?? { kind: 'user' } });
    }
    return createUserMessageFn;
  }

  async function wakeAgent(peer, prompt) {
    const route = { scope: peer.scope, targetId: peer.peerId };
    const record = await manager.getOrCreate(peer.scope, peer.peerId, peer.senderId ?? '', route);
    if (record.agent.status && record.agent.status !== 'idle') {
      log(`skip wake, agent busy: ${peer.scope}:${peer.peerId}`);
      return false;
    }
    // 主动轮次不能复用旧 msgId（被动回复只对 5 分钟内的入站消息有效）
    record.replyTarget = { scope: peer.scope, targetId: peer.peerId };
    const createUserMessage = await getCreateUserMessage();
    internalTurns.add(record.sessionId);
    record.agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }));
    log(`wake agent: ${peer.scope}:${peer.peerId}`);
    return true;
  }

  // ── 5. 定时：预约优先，其次心跳 ──
  async function tick() {
    const cfg = loadConfig();
    const proactive = cfg.proactive ?? {};
    if (!proactive.enabled) return;
    if (!inActiveHours(proactive)) return;

    const now = Date.now();
    const ttl = (proactive.peersTtlDays ?? 7) * DAY;

    const due = store.state.plans.filter((p) => p.at <= now);
    if (due.length > 0) {
      store.state.plans = store.state.plans.filter((p) => p.at > now);
      store.persist();
      for (const plan of due) {
        try {
          await wakeAgent(
            { scope: plan.scope, peerId: plan.peerId, senderId: plan.senderId, lastSeen: plan.lastSeen ?? now },
            planPrompt(plan),
          );
        } catch (err) {
          log('plan wake failed:', String(err));
        }
      }
    }

    const peers = Object.values(store.state.peers)
      .filter((p) => p && now - (p.lastSeen ?? 0) < ttl)
      .filter((p) => p.scope !== 'group' || proactive.allowGroups)
      .filter((p) => {
        const day = dayKey(now);
        return (p.proactiveDay === day ? p.proactiveCount ?? 0 : 0) < (proactive.maxPerDayPerPeer ?? 3);
      })
      .sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0))
      .slice(0, proactive.maxPeers ?? 5);

    for (const peer of peers) {
      if (now - (peer.lastSeen ?? 0) < 8 * MINUTE) continue;
      if (now - (peer.lastProactive ?? 0) < (proactive.minGapMinutes ?? 90) * MINUTE) continue;
      if (Math.random() > (proactive.probability ?? 0.55)) continue;
      try {
        const ok = await wakeAgent(peer, heartbeatPrompt(peer));
        if (ok) {
          const day = dayKey(now);
          const prevCount = peer.proactiveDay === day ? peer.proactiveCount ?? 0 : 0;
          peer.lastProactive = now;
          peer.proactiveDay = day;
          peer.proactiveCount = prevCount + 1;
          store.persist();
          log(`heartbeat → ${peer.scope}:${peer.peerId} (today #${peer.proactiveCount})`);
        }
      } catch (err) {
        log('heartbeat failed:', String(err));
      }
      break;
    }
  }

  // ── 6. 工具：立刻说 / 预约以后说 ──
  let tools;
  try {
    tools = ctx.get('tools');
  } catch {
    tools = undefined;
  }

  function resolveTarget(exec) {
    if (exec?.agent) {
      const record = manager.findByAgent(exec.agent);
      if (record?.replyTarget) return record.replyTarget;
      if (record) return { scope: record.scope, targetId: record.peerId };
    }
    return undefined;
  }

  function parseTarget(input) {
    const [scope, ...rest] = String(input).split(':');
    if (scope !== 'c2c' && scope !== 'group') throw new Error('target 需为 c2c:openid 或 group:openid');
    return { scope, targetId: rest.join(':') };
  }

  if (tools?.register) {
    tools.register({
      name: 'qq_say',
      description:
        'Send a message to the QQ user/group of the current conversation right now, in your own voice. '
        + 'Use it when you want to say something proactively instead of waiting to be asked. Keep it short and human.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'What to say. Plain conversational text.' },
          target: { type: 'string', description: 'Optional "c2c:openid" / "group:openid". Omit for current conversation.' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { sent: { type: 'boolean' }, target: { type: 'string' } },
          required: ['sent'],
          additionalProperties: false,
        },
        render: (_a, v) => [{ type: 'text', text: v?.sent ? '已发出' : '没有发出' }],
      },
      async execute(args, exec) {
        const text = String(args?.text ?? '').trim();
        if (!text) throw new Error('qq_say: text 不能为空');
        const target = args?.target ? parseTarget(args.target) : resolveTarget(exec);
        if (!target) throw new Error('qq_say: 无法确定发送目标（当前不在 QQ 会话里），请显式传 target');
        await humanSend(target, text);
        return { sent: true, target: `${target.scope}:${target.targetId}` };
      },
    });

    tools.register({
      name: 'qq_follow_up',
      description:
        'Schedule yourself to speak to this QQ user later, without them prompting you. '
        + 'Use it when something is worth bringing up in the future ("ask how the interview went in 40 minutes"). '
        + 'When the time comes you get an inner-time reminder and decide whether to speak.',
      parameters: {
        type: 'object',
        properties: {
          in_minutes: { type: 'integer', description: 'Minutes from now (1-1440).' },
          note: { type: 'string', description: 'Private note to your future self about what to bring up.' },
          target: { type: 'string', description: 'Optional "c2c:openid" / "group:openid". Omit for current conversation.' },
        },
        required: ['in_minutes', 'note'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { scheduledAt: { type: 'string' }, id: { type: 'string' } },
          required: ['scheduledAt', 'id'],
          additionalProperties: false,
        },
        render: (_a, v) => [{ type: 'text', text: `已记下：${v?.scheduledAt}` }],
      },
      async execute(args, exec) {
        const minutes = Number(args?.in_minutes ?? 0);
        if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) throw new Error('qq_follow_up: in_minutes 需在 1-1440');
        const note = String(args?.note ?? '').trim();
        if (!note) throw new Error('qq_follow_up: note 不能为空');
        const target = args?.target ? parseTarget(args.target) : resolveTarget(exec);
        if (!target) throw new Error('qq_follow_up: 无法确定目标（当前不在 QQ 会话里）');
        const record = exec?.agent ? manager.findByAgent(exec.agent) : undefined;
        const plan = {
          id: randomUUID(),
          at: Date.now() + minutes * MINUTE,
          scope: target.scope,
          peerId: target.targetId,
          senderId: record?.senderId ?? '',
          lastSeen: Date.now(),
          note,
        };
        store.state.plans.push(plan);
        store.persist();
        log(`plan +${minutes}m → ${target.scope}:${target.targetId}: ${note}`);
        return { scheduledAt: new Date(plan.at).toLocaleString('zh-CN'), id: plan.id };
      },
    });

    // ── 长期记忆工具（跨私聊 / 群聊共享） ──
    if (memoryEnabled) registerMemoryTools(tools, manager);
  } else {
    log('tools service unavailable, qq_say / qq_follow_up / memory tools not registered');
  }

  // ── 7. 定时器 ──
  let timer;
  let disposed = false;
  async function loop() {
    if (disposed) return;
    try {
      rememberFromManager();
      await tick();
    } catch (err) {
      log('tick failed:', String(err));
    }
    if (disposed) return;
    const minutes = Math.max(1, loadConfig().proactive?.tickMinutes ?? 5);
    timer = setTimeout(loop, minutes * MINUTE);
    timer.unref?.();
  }
  ctx.effect(() => {
    rememberFromManager();
    timer = setTimeout(loop, 60 * 1000);
    timer.unref?.();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, 'qq-persona.tick');

  log('installed', {
    version: VERSION,
    scope: loadConfig().memory?.scope ?? 'global',
    profile: PROFILE_DIR,
    peers: Object.keys(store.state.peers).length,
    plans: store.state.plans.length,
    facts: loadMemory().facts.length,
    streaming: config?.streaming,
  });
}
