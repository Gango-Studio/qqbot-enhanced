// Offline tests: no QQ connection, no DSH runtime — the module is driven with
// fake bot/manager/ctx objects. Run with `npm test` (node --test).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-enhanced-test-'));
process.env.USERPROFILE = tmp;
process.env.HOME = tmp;
process.env.DSH_PROFILE_DIR = tmp;
process.env.QQBOT_ENHANCED_HOME = path.join(tmp, 'runtime');

const CONFIG = path.join(tmp, 'qqbot-enhanced.json');
let seq = 0;
const writeConfig = (obj) => {
  seq += 1;
  fs.writeFileSync(CONFIG, JSON.stringify({ _seq: seq, humanize: { baseDelayMs: [0, 1], perCharDelayMs: 0, maxDelayMs: 1 }, proactive: { enabled: false }, ...obj }));
};
writeConfig({});

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const mod = await import(pathToFileURL(path.join(here, '..', 'src', 'persona.js')).href);

const sent = [];
const typed = [];
const followed = [];
const handlers = {};
const tools = {};
const disposers = [];
const agents = { c2c: { id: 'agent-c2c' }, group: { id: 'agent-group' }, other: { id: 'agent-other' } };

const bot = {
  async send(opts) {
    sent.push(opts);
    return { id: `m${sent.length}` };
  },
  async sendTyping(_target, sec) {
    typed.push(sec);
  },
  openStream() {
    throw new Error('streaming disabled in tests');
  },
};

const records = new Map();
const makeRecord = (scope, peerId) => {
  const record = {
    scope,
    peerId,
    senderId: peerId,
    sessionId: `s-${scope}-${peerId}`,
    replyTarget: {},
    agent: {
      status: 'idle',
      followup: (message) => followed.push({ scope, peerId, message }),
    },
  };
  records.set(record.sessionId, record);
  return record;
};

const manager = {
  sessions: new Map(),
  findByAgent: (agent) =>
    agent === agents.c2c
      ? makeRecord('c2c', 'user-openid')
      : agent === agents.group
        ? makeRecord('group', 'group-openid')
        : agent === agents.other
          ? makeRecord('c2c', 'stranger-openid')
          : undefined,
  findBySessionId: (id) => records.get(id),
  async getOrCreate(scope, peerId) {
    return makeRecord(scope, peerId);
  },
};

const ctx = {
  on(event, fn) {
    (handlers[event] ??= []).push(fn);
  },
  effect(fn) {
    disposers.push(fn());
  },
  get(name) {
    return name === 'tools'
      ? {
          register: (def) => {
            tools[def.name] = def;
          },
        }
      : undefined;
  },
};

const config = { streaming: true };
const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };
await mod.installPersona({ ctx, bot, manager, config, logger: quietLogger });

const send = async (text, target = { scope: 'c2c', targetId: 'user-openid', msgId: 'msg-1' }) => {
  sent.length = 0;
  typed.length = 0;
  await bot.send({ target, markdown: { content: text } });
  return sent.map((s) => s.content);
};

const assembleFor = async (agent) => {
  const sections = (
    await handlers['system-prompt/assemble'][0]({ sections: [] }, { agent }, async () => ({ sections: [] }))
  ).sections;
  return sections.find((s) => s.name === 'qq-persona:memory')?.text ?? '';
};

test('streaming is disabled once the enhancement is loaded', () => {
  assert.equal(config.streaming, false);
});

test('short replies stay a single bubble', async () => {
  const bubbles = await send('好呀');
  assert.deepEqual(bubbles, ['好呀']);
  assert.equal(typed.length, 1, 'typing indicator is shown before sending');
});

test('markdown is stripped and long replies are split', async () => {
  const bubbles = await send('**你好**！今天面试怎么样？\n\n我这边刚忙完，有点累。要早点休息哦，别又熬夜到两点');
  assert.equal(bubbles.length, 2);
  assert.equal(bubbles[0], '你好！今天面试怎么样？');
  assert.ok(!bubbles.join('').includes('**'), 'no markdown markers left');
});

test('<silent> sends nothing', async () => {
  const bubbles = await send('<silent>');
  assert.deepEqual(bubbles, []);
  assert.equal(typed.length, 0);
});

test('lists keep their line breaks inside one bubble', async () => {
  const bubbles = await send('## 安排\n- 上午：改简历\n- 下午：面试\n\n记得喝水');
  assert.equal(bubbles.length, 1);
  assert.ok(bubbles[0].includes('\n上午：改简历'), 'line breaks survived');
});

test('signature emoji is applied to every bubble when configured', async () => {
  writeConfig({ humanize: { baseDelayMs: [0, 1], perCharDelayMs: 0, maxDelayMs: 1, signatureEmoji: '✨' } });
  await new Promise((r) => setTimeout(r, 10));
  const bubbles = await send('今天面试怎么样？我这边刚忙完，有点累。要早点休息哦，别又熬夜到两点');
  assert.ok(bubbles.length >= 2);
  for (const b of bubbles) assert.ok(b.endsWith('✨'), `"${b}" should end with the signature`);
  writeConfig({});
  await new Promise((r) => setTimeout(r, 10));
});

test('memory tools are registered', () => {
  assert.deepEqual(
    Object.keys(tools).sort(),
    ['qq_follow_up', 'qq_memory_forget', 'qq_memory_list', 'qq_memory_write', 'qq_say'].sort(),
  );
});

test('shared facts reach both chats, private facts only the private chat', async () => {
  writeConfig({});
  await new Promise((r) => setTimeout(r, 10));
  await tools.qq_memory_write.execute({ text: '称呼他「小明」' }, { agent: agents.c2c });
  await tools.qq_memory_write.execute({ text: '他最近在准备面试' }, { agent: agents.group });
  await tools.qq_memory_write.execute({ text: '他私下说最近压力很大', visibility: 'private' }, { agent: agents.c2c });

  const c2c = await assembleFor(agents.c2c);
  const group = await assembleFor(agents.group);
  assert.ok(c2c.includes('压力很大'), 'private chat sees private facts');
  assert.ok(!group.includes('压力很大'), 'group never sees private facts');
  assert.ok(c2c.includes('小明') && group.includes('小明'), 'shared facts are visible in both');
  assert.ok(group.includes('准备面试'), 'facts learned in a group are shared too');
});

test('facts can be listed and forgotten', async () => {
  const listed = await tools.qq_memory_list.execute({}, { agent: agents.c2c });
  assert.ok(listed.count >= 3);
  const removed = await tools.qq_memory_forget.execute({ text: '他最近在准备面试' }, { agent: agents.group });
  assert.equal(removed.removed, 1);
  const afterList = await tools.qq_memory_list.execute({}, { agent: agents.c2c });
  assert.equal(afterList.count, listed.count - 1);
});

test('persona style section is injected for QQ sessions only', async () => {
  const withAgent = (
    await handlers['system-prompt/assemble'][0]({ sections: [] }, { agent: agents.c2c }, async () => ({ sections: [] }))
  ).sections.map((s) => s.name);
  assert.ok(withAgent.includes('qq-persona:style'));

  const noAgent = (
    await handlers['system-prompt/assemble'][0]({ sections: [] }, {}, async () => ({ sections: [] }))
  ).sections;
  assert.deepEqual(noAgent, [], 'non-QQ agents are untouched');
});

test('memory can be disabled by config', async () => {
  writeConfig({ memory: { enabled: false } });
  await new Promise((r) => setTimeout(r, 10));

  const tools2 = {};
  const handlers2 = {};
  const ctx2 = {
    on(event, fn) {
      (handlers2[event] ??= []).push(fn);
    },
    effect(fn) {
      disposers.push(fn());
    },
    get(name) {
      return name === 'tools' ? { register: (def) => { tools2[def.name] = def; } } : undefined;
    },
  };
  const bot2 = { async send() {}, async sendTyping() {}, openStream() { throw new Error('off'); } };

  await mod.installPersona({ ctx: ctx2, bot: bot2, manager, config: {}, logger: quietLogger });

  assert.ok(tools2.qq_say && tools2.qq_follow_up, 'chat tools still registered');
  assert.equal(tools2.qq_memory_write, undefined, 'memory tools are not registered');
  const names = (
    await handlers2['system-prompt/assemble'][0]({ sections: [] }, { agent: agents.c2c }, async () => ({ sections: [] }))
  ).sections.map((s) => s.name);
  assert.ok(!names.includes('qq-persona:memory-guide'));
  assert.ok(!names.includes('qq-persona:memory'));
  assert.ok(names.includes('qq-persona:style'), 'style is independent from memory');
});

test('owner scope isolates strangers but shares with the owner\'s groups', async () => {
  writeConfig({ memory: { enabled: true, scope: 'owner', owners: ['user-openid'], autoSummarize: { enabled: false } } });
  await new Promise((r) => setTimeout(r, 10));
  await tools.qq_memory_write.execute({ text: '主人喜欢喝冰美式' }, { agent: agents.c2c });
  await tools.qq_memory_write.execute({ text: '陌生人说他住在杭州' }, { agent: agents.other });

  const ownerDm = await assembleFor(agents.c2c);
  const group = await assembleFor(agents.group);
  const strangerDm = await assembleFor(agents.other);

  assert.ok(ownerDm.includes('冰美式'), 'owner sees their own facts');
  assert.ok(group.includes('冰美式'), 'owner groups share the owner bucket');
  assert.ok(strangerDm.includes('杭州'), 'stranger keeps their own facts');
  assert.ok(!group.includes('杭州'), 'stranger facts never leak into the group');
  assert.ok(!ownerDm.includes('杭州'), 'stranger facts never leak into the owner DM');
});

test('per-peer scope keeps DM and group separate', async () => {
  writeConfig({ memory: { enabled: true, scope: 'per-peer', autoSummarize: { enabled: false } } });
  await new Promise((r) => setTimeout(r, 10));
  await tools.qq_memory_write.execute({ text: 'DM 专属事实' }, { agent: agents.c2c });
  await tools.qq_memory_write.execute({ text: '群专属事实' }, { agent: agents.group });

  const dm = await assembleFor(agents.c2c);
  const group = await assembleFor(agents.group);
  assert.ok(dm.includes('DM 专属事实') && !dm.includes('群专属事实'));
  assert.ok(group.includes('群专属事实') && !group.includes('DM 专属事实'));
});

test('auto-summary wakes the agent after enough turns', async () => {
  writeConfig({ memory: { enabled: true, autoSummarize: { enabled: true, everyTurns: 3, minGapMinutes: 0 } } });
  await new Promise((r) => setTimeout(r, 10));
  const record = makeRecord('c2c', 'user-openid');
  followed.length = 0;
  const session = { header: { id: record.sessionId } };
  for (let i = 0; i < 3; i += 1) {
    handlers['session/event'][0](session, { type: 'turn/end' });
  }
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(followed.length, 1, 'one summary turn is requested');
  assert.ok(followed[0].message.content[0].text.includes('记忆整理'), 'prompt is the summary prompt');
});

after(() => {
  disposers.forEach((d) => typeof d === 'function' && d());
  fs.rmSync(tmp, { recursive: true, force: true });
});
