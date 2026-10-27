#!/usr/bin/env node
/**
 * qqbot-enhanced installer.
 *
 * Patches an already-installed @tencent-connect/dsh-qqbot profile so that the
 * enhancement module is loaded right after the gateway is wired up.
 *
 * Commands:
 *   npx qqbot-enhanced               install (default)
 *   npx qqbot-enhanced --dry-run     show what would change
 *   npx qqbot-enhanced --check       report current install state
 *   npx qqbot-enhanced --restore     restore bootstrap.js and remove persona.js
 *   npx qqbot-enhanced --profile foo target a non-default DSH profile
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(fs.readFileSync(path.join(SRC_DIR, '..', 'package.json'), 'utf8'));

const argv = process.argv.slice(2);
const has = (...flags) => flags.some((f) => argv.includes(f));
const DRY = has('--dry-run', '-n');
const CHECK = has('--check');
const RESTORE = has('--restore', '--uninstall');
const HELP = has('--help', '-h');
const VERSION = has('--version', '-v');

function argValue(flag) {
  const i = argv.indexOf(flag);
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  return eq ? eq.slice(flag.length + 1) : undefined;
}

const c = {
  dim: (s) => `\u001b[2m${s}\u001b[0m`,
  green: (s) => `\u001b[32m${s}\u001b[0m`,
  yellow: (s) => `\u001b[33m${s}\u001b[0m`,
  red: (s) => `\u001b[31m${s}\u001b[0m`,
  bold: (s) => `\u001b[1m${s}\u001b[0m`,
};

function help() {
  console.log(`
${c.bold(`qqbot-enhanced v${PKG.version}`)} — human-like chat + proactive talk + shared memory
for the official QQ bot plugin (@tencent-connect/dsh-qqbot) of DeepSeek Harness.

Usage:
  npx qqbot-enhanced [options]

Options:
  --profile <name>   DSH profile to patch (default: $DSH_PROFILE_DIR or "desktop")
  --dry-run, -n      Print the changes without writing anything
  --check            Report whether the enhancement is installed and healthy
  --restore          Restore the original bootstrap.js and remove the extension
  --version, -v      Print version
  --help, -h         Show this help

After installing, restart DeepSeek Harness so the patched bootstrap is loaded.
Runtime data: ${path.join(os.homedir(), '.dsh-qqbot')} (state, memory, log)
`);
}

function fail(msg, hint) {
  console.error(`${c.red('✗')} ${msg}`);
  if (hint) console.error(`  ${c.dim(hint)}`);
  process.exit(1);
}

function readJson(file) {
  try {
    // tolerate a UTF-8 BOM (some editors / PowerShell add one)
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return undefined;
  }
}

/** Compare dotted versions, returns -1/0/1 */
function cmpVersion(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

function resolveProfile() {
  const named = argValue('--profile');
  if (named) return path.join(os.homedir(), '.dsh', 'profiles', named);
  if (process.env.DSH_PROFILE_DIR) return process.env.DSH_PROFILE_DIR;
  return path.join(os.homedir(), '.dsh', 'profiles', 'desktop');
}

const PROFILE = resolveProfile();
const PLUGIN = path.join(PROFILE, 'node_modules', '@tencent-connect', 'dsh-qqbot');
const BOOTSTRAP = path.join(PLUGIN, 'dist', 'gateway', 'bootstrap.js');
const BACKUP = `${BOOTSTRAP}.orig`;
const PERSONA_DST = path.join(PLUGIN, 'dist', 'persona.js');
const PERSONA_SRC = path.join(SRC_DIR, 'persona.js');
const CONFIG_DST = path.join(PROFILE, 'qqbot-enhanced.json');
const CONFIG_SRC = path.join(SRC_DIR, 'config.example.json');
/** Pre-release installs used these names; both are recognised and migrated. */
const LEGACY_CONFIG = path.join(PROFILE, 'qq-persona.json');
const MARKER = '[qqbot-enhanced]';
const LEGACY_MARKER = '[qq-persona]';

const ANCHOR = 'registerSendFileTool(ctx, mediaSender, manager, config, logger);';
const ANCHOR_RE = /registerSendFileTool\([^)]*\);/;

const HOOK = `

    // ── [qqbot-enhanced] human-like chat + proactive talk + shared memory ──
    try {
        const enhanced = await import('../persona.js');
        await enhanced.installPersona({ ctx, bot, sender, manager, config, logger });
    }
    catch (err) {
        logger.error(\`${MARKER} failed to load: \${err instanceof Error ? err.message : String(err)}\`);
    }`;

if (HELP) {
  help();
  process.exit(0);
}
if (VERSION) {
  console.log(PKG.version);
  process.exit(0);
}

if (!fs.existsSync(BOOTSTRAP)) {
  fail(
    `QQ bot plugin not found at ${PLUGIN}`,
    'Install it first: npx @deepseek-ai/dsh plugin --profile <name> add @tencent-connect/dsh-qqbot',
  );
}

const pluginPkg = readJson(path.join(PLUGIN, 'package.json')) ?? {};
const pluginVersion = pluginPkg.version ?? '0.0.0';
const supported = pluginPkg.dsh?.compatibility?.dshReleases ?? {};

// ── check ────────────────────────────────────────────────────────────────
if (CHECK) {
  const boot = fs.readFileSync(BOOTSTRAP, 'utf8');
  const installed = fs.existsSync(PERSONA_DST);
  const legacy = boot.includes(LEGACY_MARKER) && !boot.includes(MARKER);
  const patched = boot.includes(MARKER) || boot.includes(LEGACY_MARKER);
  const config = fs.existsSync(CONFIG_DST) ? CONFIG_DST : fs.existsSync(LEGACY_CONFIG) ? `${LEGACY_CONFIG} (legacy)` : undefined;
  console.log(`${c.bold('qqbot-enhanced')} v${PKG.version}`);
  console.log(`profile      ${PROFILE}`);
  console.log(`plugin       @tencent-connect/dsh-qqbot ${pluginVersion}`);
  console.log(`extension    ${installed ? c.green('installed') : c.yellow('missing')}  ${PERSONA_DST}`);
  console.log(`bootstrap    ${patched ? c.green(legacy ? 'patched (legacy hook)' : 'patched') : c.yellow('not patched')}`);
  console.log(`config       ${config ? c.green(config) : c.dim('defaults (no config file)')}`);
  console.log(`backup       ${fs.existsSync(BACKUP) ? BACKUP : c.dim('none')}`);
  if (Object.keys(supported).length) {
    console.log(`tested with  ${Object.entries(supported).map(([k, v]) => `${k}: ${v}`).join(', ')}`);
  }
  process.exit(installed && patched ? 0 : 1);
}

// ── restore ──────────────────────────────────────────────────────────────
if (RESTORE) {
  if (!fs.existsSync(BACKUP)) fail(`no backup found at ${BACKUP}`, 'Cannot restore automatically; reinstall the plugin instead.');
  if (DRY) {
    console.log(`[dry-run] would restore ${BOOTSTRAP} from ${BACKUP} and delete ${PERSONA_DST}`);
    process.exit(0);
  }
  fs.copyFileSync(BACKUP, BOOTSTRAP);
  if (fs.existsSync(PERSONA_DST)) fs.unlinkSync(PERSONA_DST);
  console.log(`${c.green('✓')} restored bootstrap.js and removed the extension. Restart DeepSeek Harness.`);
  console.log(c.dim(`  config kept at ${CONFIG_DST} (delete it manually if you no longer need it)`));
  process.exit(0);
}

// ── install ──────────────────────────────────────────────────────────────
console.log(`${c.bold('qqbot-enhanced')} v${PKG.version}`);
console.log(c.dim(`profile ${PROFILE}`));
console.log(c.dim(`plugin  @tencent-connect/dsh-qqbot ${pluginVersion}`));

const pristine = fs.existsSync(BACKUP) ? fs.readFileSync(BACKUP, 'utf8') : fs.readFileSync(BOOTSTRAP, 'utf8');
let boot = fs.readFileSync(BOOTSTRAP, 'utf8');

if (!ANCHOR_RE.test(pristine)) {
  fail(
    'cannot find the injection anchor in bootstrap.js — the QQ bot plugin version may be unsupported',
    `Looked for: ${ANCHOR}\nPlease open an issue with your dsh-qqbot version (${pluginVersion}).`,
  );
}
if (cmpVersion(pluginVersion, '0.5.0') < 0) {
  console.log(c.yellow(`! dsh-qqbot ${pluginVersion} is older than 0.5.0; the patch may not apply cleanly.`));
}

if (!fs.existsSync(BACKUP)) {
  if (DRY) console.log(`[dry-run] backup ${BOOTSTRAP} -> ${BACKUP}`);
  else fs.copyFileSync(BOOTSTRAP, BACKUP);
}

const alreadyPatched = boot.includes(MARKER) || boot.includes(LEGACY_MARKER);
if (!alreadyPatched) {
  const m = ANCHOR_RE.exec(boot);
  const insertAt = m.index + m[0].length;
  boot = boot.slice(0, insertAt) + HOOK + boot.slice(insertAt);
  if (DRY) console.log(`[dry-run] inject hook into ${BOOTSTRAP}`);
  else {
    fs.writeFileSync(BOOTSTRAP, boot, 'utf8');
    console.log(`${c.green('✓')} bootstrap.js patched`);
  }
} else {
  console.log(`${c.dim('•')} bootstrap.js already patched${boot.includes(LEGACY_MARKER) && !boot.includes(MARKER) ? ' (legacy hook, kept as-is)' : ''}`);
}

if (DRY) {
  console.log(`[dry-run] copy ${PERSONA_SRC} -> ${PERSONA_DST}`);
  console.log(`[dry-run] config ${CONFIG_DST}${fs.existsSync(CONFIG_DST) ? ' (kept)' : fs.existsSync(LEGACY_CONFIG) ? ' (migrated from qq-persona.json)' : ' (defaults)'}`);
} else {
  fs.copyFileSync(PERSONA_SRC, PERSONA_DST);
  console.log(`${c.green('✓')} extension installed at ${PERSONA_DST}`);
  if (!fs.existsSync(CONFIG_DST)) {
    if (fs.existsSync(LEGACY_CONFIG)) {
      fs.copyFileSync(LEGACY_CONFIG, CONFIG_DST);
      console.log(`${c.green('✓')} migrated legacy config ${LEGACY_CONFIG} -> ${CONFIG_DST}`);
    } else {
      fs.copyFileSync(CONFIG_SRC, CONFIG_DST);
      console.log(`${c.green('✓')} default config written to ${CONFIG_DST}`);
    }
  } else {
    console.log(`${c.dim('•')} config kept: ${CONFIG_DST}`);
  }
}

console.log(`
${c.bold('Next')}
  1. Fully quit DeepSeek Harness (including the tray process) and start it again.
  2. Send the bot a message on QQ — it should reply in 1-3 short bubbles with a typing indicator.
  3. Tell it something worth remembering, then ask about it in another chat.

Logs:    ${path.join(os.homedir(), '.dsh-qqbot', 'persona.log')}
Memory:  ${path.join(os.homedir(), '.dsh-qqbot', 'memory.json')}
Restore: npx qqbot-enhanced --restore
`);
