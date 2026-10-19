import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadConfig, parseActiveHours, withinActiveHours, scanDue, preparedToday, localParts,
  classifyFailure, failureSignature, parseReadyItem, formatReadyMessage, parseCommand,
  agentEnv, parsePrepareResult, missingReadyFiles, pendingPipelineCount, evalsToday,
  healthStatus, createLock,
} from '../scripts/loop/lib.mjs';
import { ROOT } from './helpers.mjs';

test('defaults favour a few good applications over volume', () => {
  const c = loadConfig({});
  assert.equal(c.intervalMin, 30);
  assert.equal(c.scoreGate, 4.0);
  assert.equal(c.dailyCap, 8);
  assert.equal(c.autofix, false, 'autofix PRs are opt-in');
  assert.equal(c.rca, true);
  assert.equal(loadConfig({ LOOP_INTERVAL_MIN: '1' }).intervalMin, 5, 'interval floor');
});

test('active hours, including a window that wraps midnight', () => {
  assert.equal(parseActiveHours(''), null);
  assert.equal(parseActiveHours('garbage'), null);
  const day = parseActiveHours('7-23');
  assert.equal(withinActiveHours(day, 6), false);
  assert.equal(withinActiveHours(day, 7), true);
  assert.equal(withinActiveHours(day, 23), false);
  const night = parseActiveHours('22-6');
  assert.equal(withinActiveHours(night, 23), true);
  assert.equal(withinActiveHours(night, 3), true);
  assert.equal(withinActiveHours(night, 12), false);
  assert.equal(withinActiveHours(null, 3), true);
});

test('scan cadence and the daily cap reset', () => {
  const now = new Date('2026-10-19T12:00:00Z');
  assert.equal(scanDue(undefined, now, 6), true);
  assert.equal(scanDue('2026-10-19T07:00:00Z', now, 6), false);
  assert.equal(scanDue('2026-10-19T05:59:00Z', now, 6), true);
  assert.equal(preparedToday({ prepared: { day: '2026-10-19', count: 3 } }, '2026-10-19'), 3);
  assert.equal(preparedToday({ prepared: { day: '2026-10-18', count: 3 } }, '2026-10-19'), 0);
  assert.deepEqual(localParts(now, 'America/Los_Angeles'), { day: '2026-10-19', hour: 5 });
});

test('failure classification decides RCA and autofix', () => {
  assert.equal(classifyFailure({ timedOut: true }), 'timeout');
  assert.equal(classifyFailure({ stderr: 'onboardingNeeded: missing cv.md' }), 'config');
  assert.equal(classifyFailure({ stderr: 'Invalid API key · Please run /login' }), 'config');
  assert.equal(classifyFailure({ stderr: 'TypeError: fetch failed ETIMEDOUT' }), 'transient');
  assert.equal(classifyFailure({ stderr: "TypeError: Cannot read properties of undefined (reading 'x')\n    at scan.mjs:12:3" }), 'code');
});

test('the same bug yields the same signature across runs', () => {
  const a = failureSignature('scan', { stderr: 'Error: boom at /app/scan.mjs:120:4 job 4411' });
  const b = failureSignature('scan', { stderr: 'Error: boom at /app/scan.mjs:98:2 job 9001' });
  const c = failureSignature('prepare', { stderr: 'Error: boom at /app/scan.mjs:120:4 job 4411' });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('ready items are validated before they reach Telegram', () => {
  assert.equal(parseReadyItem('not json'), null);
  assert.equal(parseReadyItem({ report: '7', company: 'Acme', role: 'SWE', apply_url: 'javascript:alert(1)' }), null);
  const item = parseReadyItem({
    report: 7, company: 'Acme', role: 'SWE', score: '4.4', apply_url: 'https://jobs.ashbyhq.com/acme/1',
    answers: [{ q: 'Why?', a: 'Because.' }, { q: 'empty' }], needs_you: ['Salary'],
  });
  assert.equal(item.report, '007');
  assert.equal(item.answers.length, 1);
  const msg = formatReadyMessage(item);
  assert.match(msg, /#007/);
  assert.match(msg, /4\.4\/5/);
  assert.match(msg, /Needs your input/);
  assert.match(msg, /only after you've clicked Submit yourself/);
  assert.ok(msg.length <= 4000);
});

test('commands and button payloads parse the same way', () => {
  assert.deepEqual(parseCommand('/done 42'), { name: 'done', arg: '42' });
  assert.deepEqual(parseCommand('done:042'), { name: 'done', arg: '042' });
  assert.deepEqual(parseCommand('/status@careerops_bot'), { name: 'status', arg: '' });
  assert.equal(parseCommand(''), null);
});

test('the prepare prompt keeps the never-submit rule', () => {
  const text = readFileSync(join(ROOT, 'scripts/loop/prompts/prepare.md'), 'utf-8');
  assert.match(text, /NEVER submit/);
  assert.match(text, /NEVER mark a tracker row `Applied`/);
  assert.match(text, /untrusted data/);
});

// ── hardening (handoff §8) ───────────────────────────────────────────────────

test('agent env drops every worker secret and keeps what the CLI needs (§8.1)', () => {
  const source = {
    PATH: '/usr/bin', HOME: '/root', TZ: 'UTC', IS_SANDBOX: '1',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth', GITHUB_TOKEN: 'ghp_secret', TELEGRAM_BOT_TOKEN: '123:abc',
    ALERT_API_KEY: 'relay', DATA_REPO: 'me/data', RANDOM_VAR: 'x',
  };
  const env = agentEnv(source, { CAREER_OPS_DATA_DIR: '/data/career-ops', GITHUB_TOKEN: 'leak-attempt' });
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'oauth');
  assert.equal(env.CAREER_OPS_DATA_DIR, '/data/career-ops');
  for (const key of ['GITHUB_TOKEN', 'TELEGRAM_BOT_TOKEN', 'ALERT_API_KEY', 'DATA_REPO', 'RANDOM_VAR']) {
    assert.equal(env[key], undefined, `${key} must not reach the agent`);
  }
});

test('prepare result is read from the last JSON line and normalised (§8.2)', () => {
  const out = 'thinking...\nall good\n{"evaluated": 2, "ready": ["42"], "skipped_below_gate": ["7"], "errors": []}\n';
  assert.deepEqual(parsePrepareResult(out), { evaluated: 2, ready: ['042'], skipped_below_gate: ['007'], errors: [] });
  assert.equal(parsePrepareResult('no json here'), null);
  assert.equal(parsePrepareResult('{"ready": []}'), null, 'evaluated is required');
  assert.equal(parsePrepareResult('{broken'), null);
  assert.deepEqual(parsePrepareResult('{"evaluated":0}').ready, []);
});

test('ready ids without a ready file are reported (§8.2)', () => {
  assert.deepEqual(missingReadyFiles(['001', '002'], new Set(['001'])), ['002']);
  assert.deepEqual(missingReadyFiles([], new Set()), []);
});

test('pending count ignores done, discarded and blocked rows (§8.5)', () => {
  const text = '## Pending\n- [ ] https://a\n- [!] https://b — JD unavailable\n## Processed\n- [x] #1 | x\n- [ ] https://c\n';
  assert.equal(pendingPipelineCount(text), 2);
  assert.equal(pendingPipelineCount('## Processed\n- [x] #1\n'), 0);
});

test('evaluation count resets at local midnight (§8.5)', () => {
  assert.equal(evalsToday({ evaluated: { day: '2026-10-19', count: 9 } }, '2026-10-19'), 9);
  assert.equal(evalsToday({ evaluated: { day: '2026-10-18', count: 9 } }, '2026-10-19'), 0);
});

test('health is 503 only when a working loop has gone quiet (§8.6)', () => {
  const base = { intervalMin: 30, activeHours: null, timezone: 'UTC' };
  const now = new Date('2026-10-19T12:00:00Z');
  assert.equal(healthStatus({ ...base, now, state: { paused: true, lastSuccessAt: '2026-10-18T00:00:00Z' } }).ok, true, 'paused is healthy');
  assert.equal(healthStatus({ ...base, now, state: { lastSuccessAt: '2026-10-19T11:00:00Z' } }).ok, true, '60 min < 90 min');
  assert.equal(healthStatus({ ...base, now, state: { lastSuccessAt: '2026-10-19T10:00:00Z' } }).ok, false, '120 min > 90 min');
  assert.equal(healthStatus({ ...base, now, state: { startedAt: '2026-10-19T11:30:00Z' } }).ok, true, 'fresh start, no success yet');
  assert.equal(healthStatus({ ...base, now, state: { startedAt: '2026-10-19T08:00:00Z' } }).ok, false, 'never succeeded for hours');
  const night = { intervalMin: 30, activeHours: { start: 7, end: 23 }, timezone: 'UTC' };
  assert.equal(healthStatus({ ...night, now: new Date('2026-10-19T03:00:00Z'), state: { lastSuccessAt: '2026-10-18T00:00:00Z' } }).ok, true, 'outside active hours');
});

test('lock runs async work strictly one at a time (§8.3)', async () => {
  const lock = createLock();
  const order = [];
  const slow = lock(async () => { order.push('a-start'); await new Promise(r => setTimeout(r, 30)); order.push('a-end'); });
  const fast = lock(async () => { order.push('b'); });
  await Promise.all([slow, fast]);
  assert.deepEqual(order, ['a-start', 'a-end', 'b']);
  await assert.rejects(lock(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await lock(async () => 'still works'), 'still works', 'a failure does not wedge the lock');
});
