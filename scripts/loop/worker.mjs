#!/usr/bin/env node
/**
 * scripts/loop/worker.mjs — long-running cloud apply loop (docs/CLOUD_LOOP.md).
 *
 * Every LOOP_INTERVAL_MIN minutes: scan (when due) → evaluate the best pending
 * role(s) → prepare ONE application (tailored PDF + drafted answers) → send it to
 * Telegram for the candidate to submit. It never submits anything itself.
 *
 * On a failed step: classify it, write an RCA with a read-only agent run, alert
 * on Telegram, optionally open an autofix pull request (LOOP_AUTOFIX=1), and
 * pause after LOOP_BREAKER_THRESHOLD consecutive failures until /resume.
 *
 *   node scripts/loop/worker.mjs           # run forever
 *   node scripts/loop/worker.mjs --once    # one cycle, then exit (exit 1 on failure)
 */

import { spawn } from 'child_process';
import { createServer } from 'http';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, appendFileSync, symlinkSync, rmSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { getCareerOpsRoot } from '../../path-resolver.mjs';
import { createNotifier } from './notify.mjs';
import {
  loadConfig, localParts, withinActiveHours, scanDue, preparedToday, classifyFailure,
  failureSignature, tail, parseReadyItem, formatReadyMessage, parseCommand,
  agentEnv, parsePrepareResult, missingReadyFiles, pendingPipelineCount, evalsToday,
  healthStatus, createLock,
} from './lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '../..');
const config = loadConfig();
const DATA_ROOT = getCareerOpsRoot();
const LOOP_DIR = join(DATA_ROOT, 'data', 'loop');
const READY_DIR = join(LOOP_DIR, 'ready');
const RCA_DIR = join(LOOP_DIR, 'rca');
const STATE_FILE = join(LOOP_DIR, 'state.json');
const RUNS_FILE = join(LOOP_DIR, 'runs.jsonl');
const notifier = createNotifier(config);
const PIPELINE_FILE = join(DATA_ROOT, 'data', 'pipeline.md');
const dataLock = createLock(); // serialises git in the data repo (handoff §8.3)

const log = (...args) => console.log(new Date().toISOString(), ...args);

// ── state ────────────────────────────────────────────────────────────────────

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return { paused: false, consecutiveFailures: 0, notified: [], autofixed: {}, telegramOffset: 0 };
  }
}
function saveState() {
  mkdirSync(LOOP_DIR, { recursive: true });
  writeFileSync(`${STATE_FILE}.tmp`, JSON.stringify(state, null, 2));
  renameSync(`${STATE_FILE}.tmp`, STATE_FILE);
}
let state;

function recordRun(run) {
  mkdirSync(LOOP_DIR, { recursive: true });
  appendFileSync(RUNS_FILE, `${JSON.stringify(run)}\n`);
}
function recentRuns(n = 8) {
  try {
    return readFileSync(RUNS_FILE, 'utf-8').trim().split('\n').slice(-n).join('\n');
  } catch {
    return '';
  }
}

// ── process helpers ──────────────────────────────────────────────────────────

/**
 * Run a command with a hard timeout; never throws. With `isolated`, the child gets
 * only the agentEnv() allowlist plus `env`, never the worker's secrets (handoff §8.1).
 */
function runStep(cmd, args, { cwd = REPO, env = {}, timeoutMs = config.stepTimeoutMin * 60_000, isolated = false } = {}) {
  return new Promise(done => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    // Every isolated child must still see the data root, or it silently reads the repo instead.
    const childEnv = isolated ? agentEnv(process.env, { CAREER_OPS_DATA_DIR: DATA_ROOT, ...env }) : { ...process.env, ...env };
    const child = spawn(cmd, args, { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    const cap = s => (s.length > 200_000 ? s.slice(-200_000) : s);
    child.stdout.on('data', d => { stdout = cap(stdout + d); });
    child.stderr.on('data', d => { stderr = cap(stderr + d); });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
    }, timeoutMs);
    const finish = code => {
      clearTimeout(timer);
      done({ code, stdout, stderr, timedOut, ms: Date.now() - started, command: [cmd, ...args.map(a => (a.length > 80 ? `${a.slice(0, 77)}...` : a))].join(' ') });
    };
    child.on('error', err => { stderr += `\n${err.message}`; finish(127); });
    child.on('close', code => finish(code ?? 1));
  });
}

function claude(prompt, { args = config.claudeArgs, cwd = REPO, env = {}, timeoutMs } = {}) {
  const full = [...args];
  if (config.model) full.push('--model', config.model);
  full.push('-p', prompt, '--output-format', 'text');
  return runStep(config.claudeBin, full, { cwd, env: { CAREER_OPS_DATA_DIR: DATA_ROOT, ...env }, timeoutMs, isolated: true });
}

function fill(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? ''));
}
const prompt = name => readFileSync(join(__dirname, 'prompts', `${name}.md`), 'utf-8');

// ── git (data backup + autofix) ──────────────────────────────────────────────

/** Auth header passed per command so the token is never written to .git/config. */
function gitAuth() {
  if (!config.github.token) return [];
  const basic = Buffer.from(`x-access-token:${config.github.token}`).toString('base64');
  return ['-c', `http.extraHeader=Authorization: Basic ${basic}`];
}
const git = (cwd, ...args) => runStep('git', [...gitAuth(), '-c', 'user.name=career-ops loop', '-c', 'user.email=loop@career-ops.invalid', ...args], { cwd, timeoutMs: 5 * 60_000 });

async function bootstrapData() {
  mkdirSync(DATA_ROOT, { recursive: true });
  const { dataRepo } = config.github;
  if (!dataRepo || existsSync(join(DATA_ROOT, '.git'))) return;
  log(`[data] restoring ${dataRepo} into ${DATA_ROOT}`);
  const branch = process.env.DATA_BRANCH?.trim() || 'main';
  for (const args of [
    ['init', '-q'],
    ['remote', 'add', 'origin', `https://github.com/${dataRepo}.git`],
    ['fetch', '-q', 'origin', branch],
    ['checkout', '-q', '-f', '-B', branch, `origin/${branch}`],
  ]) {
    const r = await git(DATA_ROOT, ...args);
    if (r.code !== 0) throw new Error(`data restore failed at "git ${args[0]}": ${tail(r.stderr, 5)}`);
  }
}

async function backupDataUnlocked() {
  if (!config.github.dataRepo || !existsSync(join(DATA_ROOT, '.git'))) return;
  await git(DATA_ROOT, 'add', '-A');
  const diff = await git(DATA_ROOT, 'diff', '--cached', '--quiet');
  if (diff.code === 0) return;
  await git(DATA_ROOT, 'commit', '-q', '-m', `loop: ${new Date().toISOString()}`);
  const push = await git(DATA_ROOT, 'push', '-q', 'origin', 'HEAD');
  if (push.code !== 0) log(`[data] backup push failed: ${tail(push.stderr, 3)}`);
}

/** Commit and push the data repo. Runs under dataLock so two writers can't collide on .git/index.lock. */
const backupData = () => dataLock(backupDataUnlocked);

// ── cycle ────────────────────────────────────────────────────────────────────

/** The loop needs cv.md, profile, _profile.md and portals.yml before it can evaluate anything. */
function doctorReady(result) {
  try {
    const report = JSON.parse(result.stdout);
    if (!report.onboardingNeeded) return true;
    result.stderr = `onboardingNeeded: missing ${report.missing.join(', ')} in ${DATA_ROOT}`;
  } catch {
    result.stderr = `doctor.mjs printed no JSON: ${tail(result.stdout, 5)}`;
  }
  return false;
}

let busy = false;

async function cycle(trigger = 'schedule') {
  if (busy) return { skipped: 'busy' };
  busy = true;
  const now = new Date();
  const { day, hour } = localParts(now, config.timezone);
  const run = { at: now.toISOString(), trigger, steps: [], ok: true };
  try {
    if (state.paused && trigger === 'schedule') return { skipped: 'paused' };
    if (trigger === 'schedule' && !withinActiveHours(config.activeHours, hour)) return { skipped: 'outside active hours' };
    if (preparedToday(state, day) >= config.dailyCap) return { skipped: `daily cap ${config.dailyCap} reached` };
    if (evalsToday(state, day) >= config.dailyEvalCap) return { skipped: `daily evaluation cap ${config.dailyEvalCap} reached` };

    const steps = [
      { name: 'doctor', when: () => true, run: () => runStep('node', ['doctor.mjs', '--json'], { timeoutMs: 60_000, isolated: true }), check: doctorReady },
      { name: 'scan', when: () => scanDue(state.lastScanAt, now, config.scanEveryHours) && localParts(now, config.timezone).hour >= config.scanHour, run: () => runStep('node', ['scan.mjs', '--since', '3'], { isolated: true }), after: () => { state.lastScanAt = now.toISOString(); } },
      {
        name: 'prepare',
        // No agent call when nothing is pending: it would only spend tokens to say so (handoff §8.5).
        when: () => {
          const pending = existsSync(PIPELINE_FILE) ? pendingPipelineCount(readFileSync(PIPELINE_FILE, 'utf-8')) : 0;
          if (pending === 0) run.skippedPrepare = 'no pending entries in data/pipeline.md';
          return pending > 0;
        },
        run: () => claude(fill(prompt('prepare'), {
          DATA_ROOT, READY_DIR,
          MAX_EVALS: Math.min(config.maxEvalsPerCycle, Math.max(1, config.dailyEvalCap - evalsToday(state, day))),
          SCORE_GATE: config.scoreGate.toFixed(1),
        })),
      },
    ];

    for (const step of steps) {
      if (!step.when()) continue;
      log(`[cycle] ${step.name} …`);
      const result = await step.run();
      const ok = result.code === 0 && !result.timedOut && (!step.check || step.check(result));
      run.steps.push({ name: step.name, code: result.code, ms: result.ms, timedOut: result.timedOut });
      if (!ok) {
        run.ok = false;
        await onFailure(step.name, result, run);
        return run;
      }
      step.after?.();
      if (step.name === 'prepare') {
        const parsed = parsePrepareResult(result.stdout);
        run.prepare = parsed ?? { error: 'prepare run did not end with a result JSON line' };
        run.summary = tail(result.stdout.trim(), 1).slice(0, 500);
        if (parsed) {
          state.evaluated = { day, count: evalsToday(state, day) + parsed.evaluated };
          const onDisk = new Set(readyItems().map(i => i.report));
          const missing = missingReadyFiles(parsed.ready, onDisk);
          if (missing.length) log(`[warn] prepare listed ready ${missing.join(', ')} with no valid ready file`);
          if (parsed.errors.length) log(`[warn] prepare reported errors: ${parsed.errors.join(' | ')}`);
        } else {
          log('[warn] prepare output had no result line; evaluation count not updated');
        }
      }
    }

    run.ready = await deliverReady(day);
    state.consecutiveFailures = 0;
    state.lastSuccessAt = now.toISOString();
    if (config.healthcheckPingUrl) fetch(config.healthcheckPingUrl, { signal: AbortSignal.timeout(10_000) }).catch(() => {});
    return run;
  } catch (err) {
    run.ok = false;
    await onFailure('worker', { code: 1, stdout: '', stderr: err.stack ?? String(err), timedOut: false, command: 'worker.mjs' }, run);
    return run;
  } finally {
    if (run.steps.length || !run.ok) recordRun(run);
    saveState();
    await backupData().catch(err => log(`[data] backup error: ${err.message}`));
    busy = false;
  }
}

/** Send every ready item that has not been sent yet. */
async function deliverReady(day) {
  if (!existsSync(READY_DIR)) return [];
  const sent = [];
  for (const file of readdirSync(READY_DIR).filter(f => f.endsWith('.json')).sort()) {
    const item = parseReadyItem(readFileSync(join(READY_DIR, file), 'utf-8'));
    if (!item) {
      log(`[ready] ignoring malformed ${file}`);
      continue;
    }
    if (state.notified.includes(item.report)) continue;
    const buttons = notifier.interactive
      ? [[{ text: '✅ I submitted it', callback_data: `done:${item.report}` }, { text: '⏭ Skip', callback_data: `skip:${item.report}` }]]
      : undefined;
    const delivered = await notifier.send(formatReadyMessage(item), { buttons, key: `career-ops-ready-${item.report}` });
    if (item.pdf_path) {
      const pdf = resolve(DATA_ROOT, item.pdf_path);
      if (pdf.startsWith(DATA_ROOT) && existsSync(pdf)) await notifier.sendDocument(pdf, `CV for #${item.report} ${item.company}`);
    }
    if (!delivered) continue; // retried next cycle
    state.notified.push(item.report);
    state.prepared = { day, count: preparedToday(state, day) + 1 };
    sent.push(item.report);
  }
  return sent;
}

// ── failure handling ─────────────────────────────────────────────────────────

async function onFailure(step, result, run) {
  const cls = classifyFailure(result);
  const sig = failureSignature(step, result);
  state.consecutiveFailures = (state.consecutiveFailures ?? 0) + 1;
  Object.assign(run, { failedStep: step, class: cls, signature: sig });
  log(`[fail] ${step} (${cls}, sig ${sig}) exit=${result.code}\n${tail(result.stderr, 20)}`);
  if (config.healthcheckPingUrl) fetch(`${config.healthcheckPingUrl.replace(/\/+$/, '')}/fail`, { signal: AbortSignal.timeout(10_000) }).catch(() => {});

  let rcaText = '';
  // Transient failures retry on their own; only spend an RCA once they repeat.
  // Config problems (missing CV, bad auth) explain themselves; RCA tokens would be wasted.
  if (config.rca && cls !== 'config' && (cls !== 'transient' || state.consecutiveFailures >= 2)) {
    const r = await claude(fill(prompt('rca'), {
      STEP: step, COMMAND: result.command, CODE: result.code, TIMED_OUT: result.timedOut, CLASS: cls,
      FAILURES: state.consecutiveFailures, OUTPUT: `${tail(result.stderr, 80)}\n---\n${tail(result.stdout, 40)}`, HISTORY: recentRuns(),
    }), { args: ['--allowedTools', 'Read,Grep,Glob'], timeoutMs: 10 * 60_000 });
    rcaText = r.code === 0 ? r.stdout.trim() : `RCA run failed (exit ${r.code}): ${tail(r.stderr, 5)}`;
    mkdirSync(RCA_DIR, { recursive: true });
    const rcaFile = join(RCA_DIR, `${run.at.replace(/[:.]/g, '-')}-${step}.md`);
    writeFileSync(rcaFile, `# RCA — ${step} (${run.at})\n\nCommand: \`${result.command}\`\nExit: ${result.code} · class: ${cls} · signature: ${sig}\n\n${rcaText}\n`);
    run.rca = rcaFile;
  }

  const tripped = state.consecutiveFailures >= config.breakerThreshold;
  if (tripped) state.paused = true;
  const header = `🔴 career-ops loop: ${step} failed (${cls})` + (tripped ? `\n⏸ Paused after ${state.consecutiveFailures} failures in a row. Send /resume when fixed.` : '');
  await notifier.send(`${header}\n\n${rcaText || tail(result.stderr, 15)}`, { key: `career-ops-fail-${run.at}` });

  const fixable = /FIXABLE:\s*yes/i.test(rcaText) && /CLASS:\s*code/i.test(rcaText);
  if (config.autofix && fixable && cls === 'code') {
    const today = localParts(new Date(), config.timezone).day;
    if (state.autofixed?.[sig] !== today) {
      state.autofixed = { ...state.autofixed, [sig]: today };
      run.autofix = await autofix(sig, rcaText).catch(err => `autofix error: ${err.message}`);
    }
  }
}

/** Fix the bug on a fresh clone of CODE_REPO and open a PR. Never merges. */
async function autofix(sig, rcaText) {
  const { token, codeRepo, codeBranch } = config.github;
  if (!token || !codeRepo) return 'skipped: GITHUB_TOKEN/CODE_REPO not set';
  const dir = join(process.env.LOOP_WORK_DIR || '/tmp', `career-ops-autofix-${sig}`);
  rmSync(dir, { recursive: true, force: true });
  const branch = `loop-fix/${sig}-${Date.now().toString(36)}`;
  const clone = await runStep('git', [...gitAuth(), 'clone', '-q', '--depth', '50', '--branch', codeBranch, `https://github.com/${codeRepo}.git`, dir], { timeoutMs: 10 * 60_000 });
  if (clone.code !== 0) return `clone failed: ${tail(clone.stderr, 3)}`;
  if (existsSync(join(REPO, 'node_modules'))) symlinkSync(join(REPO, 'node_modules'), join(dir, 'node_modules'));
  await git(dir, 'checkout', '-q', '-b', branch);

  // An empty data root keeps the agent and the tests away from the candidate's real files.
  const scratch = join(dir, '.loop-scratch-data');
  mkdirSync(scratch, { recursive: true });
  const fix = await claude(fill(prompt('autofix'), { BRANCH: branch, RCA: rcaText }), { cwd: dir, env: { CAREER_OPS_DATA_DIR: scratch }, timeoutMs: 30 * 60_000 });
  rmSync(scratch, { recursive: true, force: true });
  rmSync(join(dir, 'node_modules'), { force: true });
  const status = await git(dir, 'status', '--porcelain');
  if (fix.code !== 0 || !status.stdout.trim()) {
    await notifier.send(`🛠 Autofix for ${sig} made no change.\n${tail(fix.stdout, 10)}`);
    return 'no change';
  }
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-q', '-m', `fix(loop): ${sig} — automated fix from loop RCA`);
  const push = await git(dir, 'push', '-q', 'origin', branch);
  if (push.code !== 0) return `push failed: ${tail(push.stderr, 3)}`;
  const res = await fetch(`https://api.github.com/repos/${codeRepo}/pulls`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: `fix(loop): automated fix for failure ${sig}`, head: branch, base: codeBranch, body: `${rcaText}\n\n---\n${tail(fix.stdout, 30)}\n\nOpened by the career-ops cloud loop. Review before merging; merging redeploys the loop.` }),
  });
  const pr = await res.json().catch(() => ({}));
  const url = pr.html_url ?? `branch ${branch} (PR create failed: HTTP ${res.status})`;
  await notifier.send(`🛠 Autofix ready for review: ${url}\nMerge it to redeploy, then /resume if the loop is paused.`);
  return url;
}

// ── Telegram commands ────────────────────────────────────────────────────────

const HELP = [
  '/status — loop state', '/ready — unsent/unsubmitted applications', '/run — run a cycle now',
  '/done N — mark report N Applied (after YOU submitted)', '/skip N — discard report N',
  '/pause · /resume', '/help',
].join('\n');

function readyItems() {
  if (!existsSync(READY_DIR)) return [];
  return readdirSync(READY_DIR).filter(f => f.endsWith('.json')).map(f => parseReadyItem(readFileSync(join(READY_DIR, f), 'utf-8'))).filter(Boolean);
}

async function closeItem(report, status, note) {
  const id = String(Number.parseInt(report, 10));
  if (id === 'NaN') return 'Usage: /done 42';
  const args = ['set-status.mjs', '--report', id, status];
  if (note) args.push('--note', note);
  const r = await runStep('node', args, { env: { CAREER_OPS_DATA_DIR: DATA_ROOT }, timeoutMs: 60_000 });
  if (r.code !== 0) return `❌ set-status failed: ${tail(r.stderr || r.stdout, 4)}`;
  const file = join(READY_DIR, `${id.padStart(3, '0')}.json`);
  if (existsSync(file)) {
    mkdirSync(join(READY_DIR, 'closed'), { recursive: true });
    renameSync(file, join(READY_DIR, 'closed', `${id.padStart(3, '0')}.json`));
  }
  await backupData().catch(() => {});
  return `✔ #${id} → ${status}`;
}

async function handleCommand(text) {
  const cmd = parseCommand(text);
  if (!cmd) return null;
  switch (cmd.name) {
    case 'start':
    case 'help': return HELP;
    case 'status': {
      const { day } = localParts(new Date(), config.timezone);
      return [
        `${state.paused ? '⏸ paused' : busy ? '⚙️ running' : '🟢 idle'} · failures in a row: ${state.consecutiveFailures ?? 0}`,
        `Prepared today: ${preparedToday(state, day)}/${config.dailyCap} · every ${config.intervalMin} min`,
        `Last scan: ${state.lastScanAt ?? 'never'}`,
        `Last run: ${tail(recentRuns(1), 1).slice(0, 300) || 'none'}`,
      ].join('\n');
    }
    case 'ready': {
      const items = readyItems();
      return items.length ? items.map(i => `#${i.report} ${i.company} · ${i.role}\n${i.apply_url}`).join('\n\n') : 'Nothing waiting.';
    }
    case 'run': cycle('manual').then(r => notifier.send(`Manual run: ${r.skipped ?? (r.ok ? `ok, ready ${JSON.stringify(r.ready ?? [])}` : `failed at ${r.failedStep}`)}`)); return 'Starting a cycle…';
    case 'pause': state.paused = true; saveState(); return '⏸ Paused.';
    case 'resume': state.paused = false; state.consecutiveFailures = 0; saveState(); return '▶️ Resumed.';
    case 'done': return closeItem(cmd.arg, 'Applied');
    case 'skip': return closeItem(cmd.arg, 'Discarded', 'skipped from cloud loop');
    default: return `Unknown command.\n${HELP}`;
  }
}

async function pollTelegram() {
  if (!notifier.interactive) return;
  for (;;) {
    try {
      const updates = await notifier.getUpdates(state.telegramOffset ?? 0);
      for (const u of updates) {
        state.telegramOffset = u.update_id + 1;
        const msg = u.message ?? u.callback_query?.message;
        if (String(msg?.chat?.id) !== String(notifier.chatId)) continue; // ignore everyone else
        const text = u.callback_query?.data ?? u.message?.text;
        const reply = await handleCommand(text);
        if (u.callback_query) await notifier.answerCallback(u.callback_query.id, reply?.slice(0, 190) ?? 'ok');
        if (reply) await notifier.send(reply);
      }
      if (updates.length) saveState();
    } catch (err) {
      log(`[telegram] ${err.message}`);
      await new Promise(r => setTimeout(r, 15_000));
    }
  }
}

// ── daily summary, health, scheduler ─────────────────────────────────────────

async function maybeDailySummary() {
  const { day, hour } = localParts(new Date(), config.timezone);
  if (hour !== config.summaryHour || state.summaryDay === day) return;
  state.summaryDay = day;
  saveState();
  const runs = recentRuns(200).split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(r => r && localParts(new Date(r.at), config.timezone).day === day);
  const failed = runs.filter(r => !r.ok);
  await notifier.send([
    `📊 career-ops daily · ${day}`,
    `Runs: ${runs.length} · failed: ${failed.length}`,
    `Prepared: ${preparedToday(state, day)} · waiting on you: ${readyItems().length}`,
    failed.length ? `Failures: ${[...new Set(failed.map(r => `${r.failedStep}/${r.class}`))].join(', ')}` : 'No failures.',
    state.paused ? '⏸ Loop is PAUSED — /resume' : '',
  ].filter(Boolean).join('\n'));
}

function startHealthServer() {
  if (!config.port) return;
  createServer((req, res) => {
    if (req.url !== '/health' && req.url !== '/') {
      res.writeHead(404).end();
      return;
    }
    const health = healthStatus({ state, now: new Date(), intervalMin: config.intervalMin, activeHours: config.activeHours, timezone: config.timezone });
    // Public details stay minimal: no paths, counts or tokens (handoff §5.8).
    res.writeHead(health.ok ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: health.ok, reason: health.reason }));
  }).listen(config.port, '0.0.0.0', () => log(`[health] listening on :${config.port}`));
}

async function main() {
  await bootstrapData();
  state = loadState();
  state.startedAt = new Date().toISOString();
  if (!notifier.interactive && !(config.alertRelay.url && config.alertRelay.apiKey)) log('[loop] WARNING: no Telegram bot or alert relay configured; ready items stay queued until one is.');
  log(`[loop] data root ${DATA_ROOT} · every ${config.intervalMin} min · gate ${config.scoreGate} · cap ${config.dailyCap}/day`);

  if (process.argv.includes('--once')) {
    const run = await cycle('manual');
    console.log(JSON.stringify(run, null, 2));
    process.exit(run.ok === false ? 1 : 0);
  }

  startHealthServer();
  pollTelegram();
  await notifier.send(`▶️ career-ops loop started (every ${config.intervalMin} min${state.paused ? ', currently PAUSED' : ''}). /help for commands.`);
  for (;;) {
    const started = Date.now();
    await cycle('schedule');
    await maybeDailySummary().catch(err => log(`[summary] ${err.message}`));
    // Keep a steady cadence: a 20-minute cycle on a 30-minute interval waits 10, not 30.
    const wait = Math.max(60_000, config.intervalMin * 60_000 - (Date.now() - started));
    await new Promise(r => setTimeout(r, wait));
  }
}

process.on('unhandledRejection', err => log('[unhandled]', err));
main().catch(async err => {
  log('[fatal]', err);
  await notifier.send(`💥 career-ops loop crashed on startup: ${err.message}`).catch(() => {});
  process.exit(1);
});
