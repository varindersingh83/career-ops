import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadConfig, parseActiveHours, withinActiveHours, scanDue, preparedToday, localParts,
  classifyFailure, failureSignature, parseReadyItem, formatReadyMessage, parseCommand,
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
