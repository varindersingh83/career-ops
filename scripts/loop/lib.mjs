/**
 * scripts/loop/lib.mjs — pure helpers for the cloud apply loop (docs/CLOUD_LOOP.md).
 *
 * Everything here is side-effect free so tests/cloud-loop.test.mjs can lock it
 * in without a network, a Telegram bot, or an agent CLI.
 */

import { createHash } from 'crypto';

const int = (value, fallback) => {
  const n = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(n) ? n : fallback;
};
const float = (value, fallback) => {
  const n = Number.parseFloat(String(value ?? '').trim());
  return Number.isFinite(n) ? n : fallback;
};
const bool = (value, fallback) => {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v);
};

/** Read loop settings from the environment. Defaults favour quality over volume. */
export function loadConfig(env = process.env) {
  return {
    intervalMin: Math.max(5, int(env.LOOP_INTERVAL_MIN, 30)),
    scanEveryHours: Math.max(1, int(env.LOOP_SCAN_EVERY_HOURS, 6)),
    maxEvalsPerCycle: Math.max(1, int(env.LOOP_MAX_EVALS_PER_CYCLE, 2)),
    dailyCap: Math.max(1, int(env.LOOP_DAILY_CAP, 8)),
    dailyEvalCap: Math.max(1, int(env.LOOP_DAILY_EVAL_CAP, 16)),
    scoreGate: float(env.LOOP_SCORE_GATE, 4.0),
    activeHours: parseActiveHours(env.LOOP_ACTIVE_HOURS),
    timezone: env.TZ?.trim() || 'UTC',
    summaryHour: int(env.LOOP_SUMMARY_HOUR, 20),
    breakerThreshold: Math.max(1, int(env.LOOP_BREAKER_THRESHOLD, 3)),
    stepTimeoutMin: Math.max(1, int(env.LOOP_STEP_TIMEOUT_MIN, 25)),
    claudeBin: env.LOOP_CLAUDE_BIN?.trim() || 'claude',
    claudeArgs: (env.LOOP_CLAUDE_ARGS ?? '--dangerously-skip-permissions').split(/\s+/).filter(Boolean),
    model: env.LOOP_MODEL?.trim() || '',
    rca: bool(env.LOOP_RCA, true),
    autofix: bool(env.LOOP_AUTOFIX, false),
    healthcheckPingUrl: env.HEALTHCHECK_PING_URL?.trim() || '',
    telegram: {
      botToken: env.TELEGRAM_BOT_TOKEN?.trim() || '',
      chatId: env.TELEGRAM_CHAT_ID?.trim() || '',
    },
    alertRelay: {
      url: (env.ALERT_API_URL?.trim() || '').replace(/\/+$/, ''),
      apiKey: env.ALERT_API_KEY?.trim() || '',
      destination: env.ALERT_DESTINATION?.trim() || '',
    },
    github: {
      token: env.GITHUB_TOKEN?.trim() || '',
      dataRepo: env.DATA_REPO?.trim() || '',
      codeRepo: env.CODE_REPO?.trim() || '',
      codeBranch: env.CODE_BRANCH?.trim() || 'main',
    },
    port: int(env.PORT, 0),
  };
}

/** "7-23" → {start: 7, end: 23}; empty → always active. An end before start wraps midnight. */
export function parseActiveHours(raw) {
  const m = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(String(raw ?? ''));
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (start > 23 || end > 24 || start === end) return null;
  return { start, end };
}

/** Hour (0-23) and YYYY-MM-DD of `date` in `timezone`. */
export function localParts(date, timezone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

export function withinActiveHours(activeHours, hour) {
  if (!activeHours) return true;
  const { start, end } = activeHours;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

export function scanDue(lastScanAt, now, scanEveryHours) {
  if (!lastScanAt) return true;
  const last = Date.parse(lastScanAt);
  return !Number.isFinite(last) || now.getTime() - last >= scanEveryHours * 3600_000;
}

/** How many applications were prepared today, resetting at local midnight. */
export function preparedToday(state, day) {
  return state.prepared?.day === day ? state.prepared.count : 0;
}

const TRANSIENT_RE = /\b(ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|429|502|503|504|overloaded|rate.?limit)\b/i;
const CONFIG_RE = /\b(onboardingNeeded|not logged in|invalid api key|authentication_error|please run \/login|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|ENOENT: no such file or directory, open '.*(cv\.md|profile\.yml|portals\.yml))/i;

/**
 * Classify a failed step so the loop knows what to do with it:
 *   config    → your setup is wrong (auth, missing CV); alert, never autofix
 *   transient → network / rate limit; retry next cycle
 *   timeout   → the step ran past its budget
 *   code      → a script crashed; RCA, and an autofix PR if enabled
 */
export function classifyFailure(result) {
  const text = `${result.stderr ?? ''}\n${result.stdout ?? ''}`;
  if (result.timedOut) return 'timeout';
  if (CONFIG_RE.test(text)) return 'config';
  if (TRANSIENT_RE.test(text)) return 'transient';
  return 'code';
}

/** Stable signature of a failure so the same bug triggers at most one autofix a day. */
export function failureSignature(step, result) {
  const text = `${result.stderr ?? ''}\n${result.stdout ?? ''}`;
  const line = text.split('\n').map(l => l.trim()).find(l => /error|exception|failed|cannot/i.test(l)) ?? `exit ${result.code}`;
  const normalized = line.replace(/\d+/g, 'N').replace(/(\/[\w.-]+)+/g, '<path>').slice(0, 200);
  return createHash('sha1').update(`${step}|${normalized}`).digest('hex').slice(0, 12);
}

export function tail(text, lines = 60) {
  return String(text ?? '').split('\n').slice(-lines).join('\n');
}

/** Validate a ready-queue item written by the prepare step. Returns null when unusable. */
export function parseReadyItem(raw) {
  let item;
  try { item = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
  if (!item || typeof item !== 'object') return null;
  const report = String(item.report ?? '').replace(/\D/g, '');
  if (!report || !item.company || !item.role || !/^https?:\/\//.test(String(item.apply_url ?? ''))) return null;
  return {
    report: report.padStart(3, '0'),
    company: String(item.company),
    role: String(item.role),
    score: float(item.score, NaN),
    apply_url: String(item.apply_url),
    report_path: item.report_path ? String(item.report_path) : '',
    pdf_path: item.pdf_path ? String(item.pdf_path) : '',
    answers: Array.isArray(item.answers) ? item.answers.filter(a => a && a.q && a.a).map(a => ({ q: String(a.q), a: String(a.a) })) : [],
    needs_you: Array.isArray(item.needs_you) ? item.needs_you.map(String) : [],
    notes: item.notes ? String(item.notes) : '',
  };
}

/** Plain-text Telegram message for a ready application (no parse_mode, so nothing needs escaping). */
export function formatReadyMessage(item) {
  const score = Number.isFinite(item.score) ? `${item.score.toFixed(1)}/5` : 'n/a';
  const lines = [
    `🟢 Ready to submit — #${item.report}`,
    `${item.company} · ${item.role}`,
    `Score: ${score}`,
    '',
    `Apply: ${item.apply_url}`,
  ];
  if (item.needs_you.length) {
    lines.push('', '⚠️ Needs your input:', ...item.needs_you.map(n => `• ${n}`));
  }
  if (item.answers.length) {
    lines.push('', 'Drafted answers:');
    for (const { q, a } of item.answers) lines.push(`Q: ${q}`, `A: ${a}`, '');
  }
  if (item.notes) lines.push(`Notes: ${item.notes}`);
  lines.push('', `Tap ✅ only after you've clicked Submit yourself.`);
  return truncate(lines.join('\n'), 4000);
}

export function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 20)}\n…(truncated)`;
}

/** Parse a Telegram command like "/done 42" or a button payload like "done:042". */
export function parseCommand(text) {
  const m = /^\/?(\w+)(?:@\w+)?(?:[\s:]+(\S+))?/.exec(String(text ?? '').trim());
  if (!m) return null;
  return { name: m[1].toLowerCase(), arg: m[2] ?? '' };
}

// ── hardening helpers (handoff §8.1–§8.6) ───────────────────────────────────

/**
 * Only these variables reach an agent subprocess. Job postings are untrusted, and
 * the agent runs with broad tool access, so the worker's own secrets (GitHub,
 * Telegram, the alert relay) must never be in its environment.
 */
const AGENT_ENV_KEYS = [
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TZ', 'USER', 'SHELL',
  'PLAYWRIGHT_BROWSERS_PATH', 'IS_SANDBOX', 'NODE_OPTIONS', 'XDG_CONFIG_HOME',
  'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY',
];

export function agentEnv(source = process.env, extra = {}) {
  const out = {};
  for (const key of AGENT_ENV_KEYS) {
    if (source[key] !== undefined && source[key] !== '') out[key] = source[key];
  }
  for (const [key, value] of Object.entries(extra)) {
    if (AGENT_ENV_KEYS.includes(key) || key === 'CAREER_OPS_DATA_DIR') out[key] = value;
  }
  return out;
}

/**
 * The prepare run must end with one JSON line: {evaluated, ready, skipped_below_gate, errors}.
 * Returns null when no such line exists, so the caller can flag it rather than trust it.
 */
export function parsePrepareResult(stdout) {
  const lines = String(stdout ?? '').trim().split('\n').map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('{')) continue;
    let obj;
    try { obj = JSON.parse(lines[i]); } catch { return null; }
    if (typeof obj.evaluated !== 'number') return null;
    const list = v => (Array.isArray(v) ? v.map(x => String(x).replace(/\D/g, '').padStart(3, '0')).filter(x => x !== '000') : []);
    return {
      evaluated: obj.evaluated,
      ready: list(obj.ready),
      skipped_below_gate: list(obj.skipped_below_gate),
      errors: Array.isArray(obj.errors) ? obj.errors.map(String) : [],
    };
  }
  return null;
}

/** Ready ids that have no matching, valid ready/NNN.json on disk. */
export function missingReadyFiles(ready, readyItemsById) {
  return ready.filter(id => !readyItemsById.has(id));
}

/** Count of unchecked `- [ ]` lines in the pipeline. `[!]` and `[x]` rows don't count. */
export function pendingPipelineCount(text) {
  return String(text ?? '').split('\n').filter(l => /^- \[ \] /.test(l)).length;
}

export function evalsToday(state, day) {
  return state.evaluated?.day === day ? state.evaluated.count : 0;
}

/**
 * Health for /health. 503 only when the loop should be working and has not
 * completed a cycle within 3 intervals. Paused, or outside active hours, is healthy.
 */
export function healthStatus({ state, now, intervalMin, activeHours, timezone }) {
  const { hour } = localParts(now, timezone);
  if (state.paused) return { ok: true, reason: 'paused' };
  if (!withinActiveHours(activeHours, hour)) return { ok: true, reason: 'outside active hours' };
  const limitMin = 3 * intervalMin;
  // Measure from the last success, or from process start when there has been none yet.
  const since = Date.parse(state.lastSuccessAt ?? '') || Date.parse(state.startedAt ?? '');
  if (!Number.isFinite(since)) return { ok: true, reason: 'no reference time yet' };
  const ageMin = (now.getTime() - since) / 60_000;
  return ageMin <= limitMin
    ? { ok: true, reason: 'recent cycle' }
    : { ok: false, reason: `no successful cycle for ${Math.round(ageMin)} min (limit ${limitMin})` };
}

/** Serialises async work. Used so a Telegram ✅ and a cycle never run git in the data repo at once. */
export function createLock() {
  let tail = Promise.resolve();
  return fn => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
}
