# Cloud Apply Loop: Handoff Notes

> **Who this is for:** the next agent or model picking up the "always-on cloud apply loop" work.
> It records what the user asked for, every decision and why, every file that was added or changed, how the code works, what was tested, what is known to be missing or risky, and an ordered checklist of what to do next.
> Read it top to bottom before touching code. The user-facing setup guide is a separate file, [`docs/CLOUD_LOOP.md`](CLOUD_LOOP.md).

---

## 0. TL;DR

- **Goal:** career-ops runs 24/7 in the cloud (laptop closed). It keeps finding and preparing job applications, about one every 30 minutes, and reports failures with an RCA and a fix.
- **Built:** a long-running Node worker under `scripts/loop/`, deployed on **Railway**, using **Telegram** for hand-off and alerts. It prepares applications and the **user submits them**: the loop never clicks Submit, a hard repo rule.
- **State:** code is complete and unit/E2E-tested locally with a fake Claude and a mock Telegram. It has **not** been run on real Railway or real Claude.
- **Commit:** `d853694` on local branch `claude/wonderful-ptolemy-n6qcg5`, **not pushed**. The push to `career-ops-hq/career-ops` failed with HTTP 403: that is the upstream repo, the session had no write access, and it isn't the user's fork. A patch was exported with `git format-patch` (see §9).
- **Next:** get the code onto the user's fork, fix the open issues in §8 (especially **§8.1, secret exposure to the agent**), then deploy following §10.

---

## 1. What the user asked for (requirements)

From the conversation, in the user's words, paraphrased only lightly:

1. "In this repo I tell it to apply for jobs I might be qualified for. It picks the top four or five jobs and applies." It may use a **browser session**, and it **asks the user questions** along the way.
2. "How can I keep running this as a **loop**… apply for one job every **30 minutes**… constantly applying."
3. "Keeps running **in the cloud** so even if my machine is closed it is consistently running."
4. "In case of **failure I get a report**, there's an **RCA**, you do analysis, then **re-engineer / do bug fixes** on this loop so it's constantly running."
5. Follow-up answers:
   - **Hosting:** "You pick one, cheapest and reliable. I have **Railway** if you need that." → Railway chosen.
   - **Notifications:** "**Telegram**. I had a repo that would send me alerts": <https://github.com/varindersingh83/email-alert> (details in §6).
6. Latest request: write these detailed handoff notes into the repo, referencing every file path.

---

## 2. Hard constraints from the repo (do NOT violate)

These come from `AGENTS.md` (loaded via `CLAUDE.md`) and shaped the whole design:

| Constraint | Where it lives | Effect on the design |
|---|---|---|
| **Never submit an application without the user reviewing it.** Fill and draft, but always STOP before Submit/Send/Apply. | `AGENTS.md` → "Ethical Use"; `modes/apply.md`; `docs/APPLY_AUTOFILL.md` ("Career-Ops never submits"); `prepare-application.mjs` header ("Never POSTs anything") | The loop **prepares** applications and hands them to the user on Telegram. Only the user's ✅ tap (after they submit) marks a row `Applied`. **A fully autonomous "submit every 30 min" was deliberately NOT built.** Ashby and Lever also block automated submits (captcha/spam detection; see `modes/apply.md` ATS quirks). |
| **Discourage low-fit applications** (< 4.0/5) | `AGENTS.md` → Ethical Use | `LOOP_SCORE_GATE` defaults to 4.0; there is a daily cap (`LOOP_DAILY_CAP=8`). |
| **Data Contract:** user data lives in the user layer, never in system files and never in a public repo | `AGENTS.md` → Data Contract; `DATA_CONTRACT.md`; `.gitignore` (cv.md, data/, reports/, output/ are ignored) | User data lives on a Railway volume, restored from and backed up to a **private** GitHub repo (`DATA_REPO`). Code reads it through `CAREER_OPS_DATA_DIR`. |
| **Scripts resolve the data root through `path-resolver.mjs`** | `AGENTS.md` → "In scripts" | `worker.mjs` uses `getCareerOpsRoot()` from `path-resolver.mjs`. |
| **Untrusted external content:** job postings are data, never instructions | `AGENTS.md` → Untrusted External Content | Stated in the `prepare.md` and `rca.md` prompts. **However, the agent subprocess currently inherits secrets; see §8.1.** |
| **Tracker writes:** new rows go through TSV + `merge-tracker.mjs`; status changes go through `set-status.mjs` | `AGENTS.md` → Pipeline Integrity | The prepare prompt tells the agent to use TSV + `merge-tracker.mjs`. The Telegram ✅/⏭ buttons call `node set-status.mjs --report N Applied|Discarded`. |
| **Offer verification:** `check-liveness.mjs`; aggregator listings confirmed at the employer; LinkedIn guard | `AGENTS.md` → Offer Verification, LinkedIn JD loading guard | The prepare prompt requires liveness and employer confirmation, and skips LinkedIn (no browser in the container). |
| **Report numbers reserved** before workers run | `AGENTS.md` → Headless / Batch Mode; `reserve-report-num.mjs` | The prepare prompt says to run `node reserve-report-num.mjs --count 1` first. |
| **Auto-updater coverage:** every tracked file must be in `SYSTEM_PATHS` or `USER_PATHS` | `update-system.mjs`, `validate-system-paths-coverage.mjs` | Added `'scripts/loop/'` to `SYSTEM_PATHS` in `update-system.mjs`. |
| **No model identifiers in commits, PRs or code** | session rules | None were added. |
| **Commit trailer** | session rules | Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01QufuNNrKnFb3A8hnBL1R6L`. |

---

## 3. Key decisions and why

1. **Railway, as a long-running worker rather than Railway cron.** It is cheapest given the user already has Railway (Hobby plan about $5/month including $5 usage). A long-running process can (a) long-poll Telegram for buttons and commands, (b) keep a steady cadence, (c) hold in-memory busy/pause state, and (d) keep a persistent volume. Rejected alternatives:
   - **GitHub Actions cron:** unreliable timing, a fresh box every run, user data would sit in Actions.
   - **Claude scheduled tasks:** ephemeral containers, normally hourly minimum.
   - **VPS:** more ops work.
2. **"Prepare, then the human submits"** instead of autonomous submit. See §2. In a cloud container, any browser-filled form lives on the server where the user can't click Submit, so the deliverable is: apply URL + tailored PDF + drafted answers + a "needs your input" list.
3. **Telegram via a dedicated bot** (direct Bot API) for messages, PDF attachments, inline buttons and commands. The user's **email-alert** service is supported as an optional **text-only fallback relay** for alerts. A separate bot is required because Telegram allows **one `getUpdates` consumer per bot** (the email-alert README warns about the same thing).
4. **Data persistence:** Railway volume at `/data`, data root `/data/career-ops`. On first boot it is restored from a private GitHub repo; after each cycle it is committed and pushed back. That gives a backup, a history of what the loop did, and a way for the user to edit their CV or profile from anywhere.
5. **Agent runs use the `claude -p` headless CLI** (the same headless pattern as `scripts/followup-sweep.sh` and the `AGENTS.md` Headless table). Auth is `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`, the user's Pro/Max plan) or `ANTHROPIC_API_KEY`.
6. **Failure handling** has five layers:
   - classify (`config` / `transient` / `timeout` / `code`);
   - a **read-only** RCA agent run (`--allowedTools Read,Grep,Glob`), skipped for `config` failures and for the first `transient` one;
   - a Telegram alert carrying the RCA;
   - an **opt-in** autofix that opens a PR on the user's fork (never merges; at most one per failure signature per day);
   - a **circuit breaker** that pauses after 3 consecutive failures until `/resume`.
7. **Dead-man's switch:** an optional `HEALTHCHECK_PING_URL` (healthchecks.io, with its own Telegram integration), because Railway restarting a crashed process doesn't cover the whole service dying.

---

## 4. Files added or changed (commit `d853694`)

All paths are repo-relative from the career-ops root.

### New files

| Path | Lines | Purpose |
|---|---|---|
| `scripts/loop/worker.mjs` | ~451 | **Main entrypoint.** Scheduler, cycle, failure handling and RCA, autofix, Telegram command poller, daily summary, health server, data restore/backup. `node scripts/loop/worker.mjs` runs forever; `--once` runs one cycle and exits 1 on failure. |
| `scripts/loop/lib.mjs` | ~180 | **Pure helpers, no side effects; this is what the tests cover.** Config parsing, active hours, scan cadence, daily cap, failure classification and signature, ready-item validation, Telegram message formatting, command parsing. |
| `scripts/loop/notify.mjs` | ~107 | Telegram client (direct Bot API: `sendMessage` with inline keyboard, `sendDocument` multipart, `getUpdates` long-poll, `answerCallbackQuery`) plus the email-alert relay fallback (`POST {ALERT_API_URL}/send`). Honors the `TELEGRAM_API_BASE` env, which tests use to point at a mock. |
| `scripts/loop/prompts/prepare.md` | 43 | Prompt for the per-cycle agent run: pick the best pending role, auto-pipeline it, prepare the application, write the ready JSON. Placeholders: `{{DATA_ROOT}} {{READY_DIR}} {{MAX_EVALS}} {{SCORE_GATE}}`. |
| `scripts/loop/prompts/rca.md` | 33 | Read-only RCA prompt. Placeholders: `{{STEP}} {{COMMAND}} {{CODE}} {{TIMED_OUT}} {{CLASS}} {{FAILURES}} {{OUTPUT}} {{HISTORY}}`. The reply must end with `CLASS: code\|data\|external\|config` and `FIXABLE: yes\|no`. |
| `scripts/loop/prompts/autofix.md` | 11 | Autofix prompt run inside a fresh clone of the user's fork. Placeholders: `{{BRANCH}} {{RCA}}`. Reproduce or add a test, make a minimal fix, run `node test-all.mjs --quick`, don't commit. |
| `scripts/loop/Dockerfile` | 28 | Railway image. Based on `mcr.microsoft.com/playwright:v1.64.1-jammy` (same as the root `Dockerfile`), adds git and tini, `npm install`, global `@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}` (default `latest`, **should be pinned**, see §8). **COPIES the sources** (the root `Dockerfile` does not; it expects a bind mount). Env: `CAREER_OPS_DATA_DIR=/data/career-ops`, `LOOP_WORK_DIR=/tmp`, `IS_SANDBOX=1`. CMD: `node scripts/loop/worker.mjs`. |
| `scripts/loop/railway.json` | 13 | Railway config-as-code: Dockerfile builder at `scripts/loop/Dockerfile`, `healthcheckPath: /health`, `restartPolicyType: ALWAYS`, 1 replica. The user must set the service's **Config-as-code path** to this file. |
| `scripts/loop/.env.example` | ~40 | Every environment variable with comments (copy into Railway Variables). The full table is in §5. |
| `tests/cloud-loop.test.mjs` | 90 | 8 `node:test` tests over `lib.mjs`, plus an assertion that `prepare.md` keeps the never-submit, never-mark-Applied and untrusted-data rules. Auto-discovered by `test-all.mjs`. |
| `docs/CLOUD_LOOP.md` | 135 | **User-facing setup guide:** what it does, cost, 6-step setup, Telegram commands, settings table, files written, limits. |
| `docs/CLOUD_LOOP_HANDOFF.md` | — | This file. |

### Modified files

| Path | Change |
|---|---|
| `update-system.mjs` | Added `'scripts/loop/',` to the `SYSTEM_PATHS` array, right after `'scripts/followup-sweep.sh',` (around line 330). Without it, `validate-system-paths-coverage.mjs` fails and the auto-updater wouldn't ship the loop. |
| `docs/AUTOMATION.md` | Added a bullet at the end of "How this fits the rest of career-ops" linking to `CLOUD_LOOP.md`. |

### Existing files the loop depends on (read these to understand it)

| Path | Why it matters |
|---|---|
| `AGENTS.md` / `CLAUDE.md` | All rules. The headless agent reads them automatically because it runs with cwd = repo root. |
| `DATA_CONTRACT.md` | User layer vs system layer; data-root override (`CAREER_OPS_DATA_DIR`). |
| `path-resolver.mjs` | `getCareerOpsRoot()`, the data-root resolution used by `worker.mjs`. |
| `doctor.mjs` | `node doctor.mjs --json` is the loop's preflight. It prints `{"onboardingNeeded":bool,"missing":[...]...}` and **exits 0 even when onboarding is needed**, so `worker.mjs` → `doctorReady()` parses the JSON. |
| `scan.mjs` | Zero-token portal scanner, run every `LOOP_SCAN_EVERY_HOURS`. Appends to `{DATA_ROOT}/data/pipeline.md` under `## Pending`. |
| `modes/pipeline.md`, `modes/auto-pipeline.md`, `modes/oferta.md`, `modes/triage.md`, `modes/apply.md`, `modes/pdf.md` | The flows the prepare prompt tells the agent to follow. |
| `batch/batch-prompt.md` | Reference for a self-contained headless worker prompt (report, PDF, tracker TSV). A possible alternative to the prepare prompt. |
| `check-liveness.mjs` | Liveness check required before evaluating. |
| `reserve-report-num.mjs` | Report-number reservation. |
| `merge-tracker.mjs` | Merges `{DATA_ROOT}/batch/tracker-additions/*.tsv` into the tracker. |
| `set-status.mjs` | Status updates from the Telegram buttons. Usage: `node set-status.mjs --report N <State> [--note "..."]`. Canonical states are in `templates/states.yml`. |
| `prepare-application.mjs` | Greenhouse/Ashby/Lever prefill summary (never POSTs). The prepare prompt uses it to read form questions. |
| `application-answers.mjs` | Defines the `## Application Answers` report section (`**State:** filled\|submitted`). |
| `scripts/followup-sweep.sh` | The existing headless `claude -p` automation pattern that the worker mirrors. |
| `docs/AUTOMATION.md`, `docs/APPLY_AUTOFILL.md`, `DOCKER.md`, `Dockerfile`, `docker-compose.yml` | Existing automation, apply and Docker docs. |
| `test-all.mjs`, `tests/helpers.mjs`, `tests/README.md` | Test runner and conventions (`tests/**/*.test.mjs` auto-discovered; `ROOT` exported from helpers). |
| `validate-system-paths-coverage.mjs` | Must stay green after adding files. |

---

## 5. How the code works (detailed)

### 5.1 Process layout (`scripts/loop/worker.mjs`)

Module-level constants (around lines 29-40):
- `REPO`: repo root (`scripts/loop/../..`).
- `DATA_ROOT`: `getCareerOpsRoot()`.
- `LOOP_DIR`: `{DATA_ROOT}/data/loop`, which holds:
  - `READY_DIR` = `ready/`
  - `RCA_DIR` = `rca/`
  - `STATE_FILE` = `state.json`
  - `RUNS_FILE` = `runs.jsonl`

`main()` (around line 421):
1. `bootstrapData()`: if `DATA_REPO` is set and `{DATA_ROOT}/.git` doesn't exist, it runs `git init`, `remote add origin https://github.com/{DATA_REPO}.git`, `fetch origin {DATA_BRANCH}`, and `checkout -f -B {branch} origin/{branch}`. A failure throws, so startup crashes, a Telegram "💥 crashed on startup" message goes out, and Railway restarts the service.
2. `state = loadState()`.
3. Warns if no Telegram bot and no relay are configured.
4. With `--once`: runs `cycle('manual')`, prints the run JSON, and exits 0 or 1.
5. Otherwise: `startHealthServer()` (only if `PORT` is set), `pollTelegram()` (runs in the background with no await), sends a "▶️ started" message, then loops forever: `cycle('schedule')` → `maybeDailySummary()` → sleep `max(60s, interval - elapsed)` to keep a steady cadence.

### 5.2 One cycle (`cycle(trigger)`, around line 162)

- **Guards:**
  - A `busy` flag prevents overlap; a manual `/run` during a cycle returns `{skipped:'busy'}`.
  - Paused → skip, for scheduled runs only. Manual `/run` deliberately bypasses the pause.
  - Outside `LOOP_ACTIVE_HOURS` (local time in `TZ`) → skip, scheduled runs only.
  - `preparedToday(state, day) >= LOOP_DAILY_CAP` → skip.
- **Steps**, in order:
  1. `doctor`: `node doctor.mjs --json`, 60 s timeout; checked by `doctorReady()`, which fails with `onboardingNeeded: missing ...`.
  2. `scan`: only when `scanDue(state.lastScanAt, now, LOOP_SCAN_EVERY_HOURS)`. Runs `node scan.mjs` and on success sets `state.lastScanAt`.
  3. `prepare`: `claude(fill(prepare.md, …))`, which runs `claude <LOOP_CLAUDE_ARGS> [--model M] -p <prompt> --output-format text` with cwd = repo and env `CAREER_OPS_DATA_DIR=DATA_ROOT`. Success means exit 0 and no timeout. `run.summary` is the last stdout line (the agent is told to end with a JSON line, but it is **not parsed or validated yet**; see §8).
- Every step runs through `runStep()`: spawn, a hard timeout (`LOOP_STEP_TIMEOUT_MIN`, default 25 min; SIGTERM then SIGKILL after 10 s), stdout and stderr each capped at 200 KB. It never throws and returns `{code, stdout, stderr, timedOut, ms, command}`.
- **On step failure:** `onFailure(step, result, run)`, then return.
- **After the steps:** `deliverReady(day)`, reset `state.consecutiveFailures = 0`, and ping `HEALTHCHECK_PING_URL`.
- **`finally`:** append to `runs.jsonl` (only if steps ran or it failed), `saveState()` (atomic write via tmp + rename), `backupData()` (git add/commit/push in the data root if it is a git repo and `DATA_REPO` is set), then clear `busy`.

### 5.3 Ready queue (`deliverReady`, around line 211)

- Reads `{DATA_ROOT}/data/loop/ready/*.json` and validates each with `parseReadyItem()` from `lib.mjs`. Requirements: a numeric report, company, role, and an `http(s)` `apply_url`; the report is zero-padded to 3 digits; answers without `q` or `a` are dropped.
- Skips reports already in `state.notified`.
- Sends `formatReadyMessage(item)` (plain text, ≤ 4000 chars, ends with "Tap ✅ only after you've clicked Submit yourself."), with inline buttons `done:<report>` / `skip:<report>` when the direct bot is configured. Then sends the PDF if `pdf_path` resolves inside `DATA_ROOT` and exists.
- Only marks the item notified, and increments `state.prepared = {day, count}`, when the send succeeds. Otherwise it retries next cycle.
- **Ready JSON schema**, written by the prepare agent to `{READY_DIR}/{report}.json`:

  ```json
  {"report":"042","company":"Acme","role":"Senior Backend Engineer","score":4.3,
   "apply_url":"https://employer.example/jobs/123",
   "report_path":"reports/042-acme-2026-10-19.md","pdf_path":"output/cv-name-042-acme.pdf",
   "answers":[{"q":"Why Acme?","a":"..."}],"needs_you":["Desired salary: not set in profile.yml"],
   "notes":"one line"}
  ```

  `report_path` and `pdf_path` are relative to the data root.

### 5.4 Failure handling (`onFailure`, around line 239; `lib.mjs` classify/signature)

- `classifyFailure(result)` in `lib.mjs`:
  - `timedOut` → `timeout`
  - matches `CONFIG_RE` (onboardingNeeded, not logged in, invalid api key, authentication_error, "please run /login", missing cv.md/profile.yml/portals.yml ENOENT) → `config`
  - matches `TRANSIENT_RE` (ETIMEDOUT, ECONNRESET, ECONNREFUSED, ENOTFOUND, EAI_AGAIN, socket hang up, fetch failed, 429/502/503/504, overloaded, rate limit) → `transient`
  - anything else → `code`
- `failureSignature(step, result)`: sha1 of the step plus the first error-looking line, with digits replaced by `N` and paths by `<path>`, truncated to 12 hex characters. The same bug yields the same signature.
- Then:
  1. Increment `state.consecutiveFailures` and ping `HEALTHCHECK_PING_URL/fail`.
  2. **RCA:** runs if `LOOP_RCA` is on, the class isn't `config`, and the failure isn't a first `transient` one. `claude` runs with args `['--allowedTools','Read,Grep,Glob']` (read-only, **no** skip-permissions) and a 10 min timeout. The RCA is saved to `{DATA_ROOT}/data/loop/rca/{ISO-ts}-{step}.md`.
  3. **Breaker:** if `consecutiveFailures >= LOOP_BREAKER_THRESHOLD` (3), set `state.paused = true`.
  4. Telegram alert: `🔴 career-ops loop: {step} failed ({class})`, plus the RCA text (or the stderr tail) and a pause notice.
  5. **Autofix:** runs if `LOOP_AUTOFIX` is on, the RCA contains both `FIXABLE: yes` and `CLASS: code`, the pre-class is `code`, and `state.autofixed[sig] !== today`. Then `autofix(sig, rcaText)`.

### 5.5 Autofix (`autofix`, around line 278)

1. Requires `GITHUB_TOKEN` and `CODE_REPO`.
2. Clones `https://github.com/{CODE_REPO}.git` at `CODE_BRANCH` (depth 50) into `{LOOP_WORK_DIR}/career-ops-autofix-{sig}`.
3. Symlinks `node_modules` from `/app` and creates branch `loop-fix/{sig}-{base36 time}`.
4. Runs `claude` (with `LOOP_CLAUDE_ARGS`) in the clone, with `CAREER_OPS_DATA_DIR` pointed at an empty scratch directory inside the clone, using the autofix prompt; 30 min timeout. Then removes the scratch directory and the symlink.
5. If nothing changed, sends "made no change". Otherwise it commits, pushes, opens a PR through the GitHub REST API (`POST /repos/{CODE_REPO}/pulls`), and sends the PR link to Telegram.
6. **Never merges.** Merging redeploys Railway, assuming Railway auto-deploys from `CODE_BRANCH`.

### 5.6 Git auth (`gitAuth`, around line 112)

The token is passed per command as `-c http.extraHeader=Authorization: Basic base64(x-access-token:TOKEN)`, so it is **never written to `.git/config`** on the volume. That matters because the read-only RCA agent can read files.

### 5.7 Telegram (`notify.mjs` + `pollTelegram` / `handleCommand` in `worker.mjs`)

- **`createNotifier(config)`:**
  - `send(text, {buttons, key})` tries the direct bot first, then the relay (`Idempotency-Key` = `key` or a random UUID); with no channel at all it logs to the console.
  - `sendDocument(path, caption)` (direct bot only).
  - `getUpdates(offset)`: long-poll with a 50 s timeout; allowed updates are message and callback_query.
  - `answerCallback`.
- **`pollTelegram()`:** loops forever, stores `state.telegramOffset`, and **ignores any chat whose id ≠ `TELEGRAM_CHAT_ID`**. On an error it waits 15 s.
- **Commands** (`handleCommand`; button payloads `done:042` parse the same way via `parseCommand`):

  | Command | Behaviour |
  |---|---|
  | `/help`, `/start` | Help text |
  | `/status` | State line, prepared today vs cap, last scan, last run |
  | `/ready` | Lists ready items (anything still in `ready/`, not just unsent ones) |
  | `/run` | Async manual cycle, then reports the result |
  | `/pause` | Sets `paused` |
  | `/resume` | Unpauses and resets the failure count |
  | `/done N` | `closeItem(N,'Applied')`: runs `node set-status.mjs --report N Applied`, moves `ready/NNN.json` to `ready/closed/`, backs up |
  | `/skip N` | Same, with `Discarded --note "skipped from cloud loop"` |

### 5.8 Daily summary and health

- `maybeDailySummary()` runs once per local day when `hour === LOOP_SUMMARY_HOUR`. It reports runs, failures, prepared count, how many are waiting, and the pause state. It is only checked between cycles, so it fires on the first cycle boundary inside that hour; cycles still tick (quickly skipped) outside active hours.
- `startHealthServer()`: `GET /` or `/health` returns `{ok:true, paused, busy, consecutiveFailures, lastScanAt}`. It **always returns ok:true** (see §8). Railway only uses it to gate deploys.

### 5.9 State and file formats (all in the user layer, under `{DATA_ROOT}/data/loop/`)

- `state.json`:

  ```json
  {"paused":false,"consecutiveFailures":0,"notified":["012"],"autofixed":{"<sig>":"YYYY-MM-DD"},
   "telegramOffset":123,"lastScanAt":"ISO","prepared":{"day":"YYYY-MM-DD","count":1},"summaryDay":"YYYY-MM-DD"}
  ```

- `runs.jsonl`: one JSON object per line:

  ```json
  {"at","trigger","steps":[{"name","code","ms","timedOut"}],"ok","summary"?,"ready"?,
   "failedStep"?,"class"?,"signature"?,"rca"?,"autofix"?}
  ```

- `rca/*.md`: header (command, exit, class, signature) plus the agent's RCA markdown.
- `ready/*.json` (pending) and `ready/closed/*.json` (after ✅/⏭).

### 5.10 Environment variables (see `scripts/loop/.env.example`; parsed in `lib.mjs` → `loadConfig`)

| Var | Default | Notes |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` | — | One is required for the `claude` CLI |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | — | Dedicated bot; enables buttons and commands |
| `TELEGRAM_API_BASE` | `https://api.telegram.org` | Test hook (mock server) |
| `ALERT_API_URL`, `ALERT_API_KEY`, `ALERT_DESTINATION` | — | email-alert relay (text only) |
| `GITHUB_TOKEN` | — | Fine-grained PAT: Contents RW + Pull requests RW on `DATA_REPO` and `CODE_REPO` |
| `DATA_REPO`, `DATA_BRANCH` | —, `main` | Private data repo `owner/name` |
| `CODE_REPO`, `CODE_BRANCH` | —, `main` | User's fork, for autofix PRs |
| `CAREER_OPS_DATA_DIR` | `/data/career-ops` (set in the Dockerfile) | Data root |
| `TZ` | `UTC` | Active hours, daily cap day, summary hour |
| `LOOP_INTERVAL_MIN` | 30 (min 5) | Cadence |
| `LOOP_SCAN_EVERY_HOURS` | 6 | Scan cadence |
| `LOOP_MAX_EVALS_PER_CYCLE` | 2 | Evaluations per cycle |
| `LOOP_DAILY_CAP` | 8 | Prepared (delivered) applications per day |
| `LOOP_SCORE_GATE` | 4.0 | Minimum score to prepare |
| `LOOP_ACTIVE_HOURS` | always | e.g. `7-23`; `22-6` wraps midnight |
| `LOOP_SUMMARY_HOUR` | 20 | Daily summary hour |
| `LOOP_BREAKER_THRESHOLD` | 3 | Pause after N consecutive failures |
| `LOOP_STEP_TIMEOUT_MIN` | 25 | Per-step timeout |
| `LOOP_RCA` | 1 | RCA on/off |
| `LOOP_AUTOFIX` | 0 | Autofix PRs on/off |
| `LOOP_MODEL` | — | `claude --model` |
| `LOOP_CLAUDE_BIN` | `claude` | Test hook (fake CLI) |
| `LOOP_CLAUDE_ARGS` | `--dangerously-skip-permissions` | Flags for the prepare and autofix runs |
| `LOOP_WORK_DIR` | `/tmp` | Autofix clone location |
| `HEALTHCHECK_PING_URL` | — | healthchecks.io dead-man's switch |
| `PORT` | — | Railway sets it; enables `/health` |
| `IS_SANDBOX` | `1` (Dockerfile) | Lets `--dangerously-skip-permissions` run as root in the container. **Verify** with the installed CLI version |

---

## 6. The user's email-alert repo (context)

<https://github.com/varindersingh83/email-alert> is a Python service on Railway (`server.py`, PostgreSQL queue, `railway.json` with the RAILPACK builder and `/health`):

- **Env:** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_DESTINATIONS_JSON` (named chats) or legacy `TELEGRAM_CHAT_ID`, `LOCAL_API_KEY`, `DATABASE_URL`.
- **API:** `POST /send` with header `Authorization: Bearer <LOCAL_API_KEY>`, header `Idempotency-Key: <unique>`, body `{"text":"...","destination":"name"}` → `202 {"ok":true,"job_id":N,"status":"queued"}`. Also `GET /jobs/{id}`, `GET /destinations`, `GET /health`.
- Durable at-least-once delivery, retries with backoff, text only (no buttons, documents or `getUpdates`).
- `get_chat_id.py` prints chat IDs for a bot token, which is useful for finding `TELEGRAM_CHAT_ID`.
- Its README warns that `getUpdates` conflicts with an existing poller on the same bot. That's why the loop needs its **own** bot for interactive use.

`scripts/loop/notify.mjs` → `viaRelay()` implements the client side of this API.

---

## 7. What was tested

Commands were run in the session container (Node 22, after `npm install`):

1. `node --test tests/cloud-loop.test.mjs` → **8/8 pass.**
2. **E2E happy path:** `node scripts/loop/worker.mjs --once` with a fake `claude` script (via `LOOP_CLAUDE_BIN`) that writes `ready/012.json`, and a temporary data root built from `examples/cv-example.md`, `config/profile.example.yml`, `modes/_profile.template.md` and `templates/portals.example.yml`. Result: doctor and prepare ran, and the ready message rendered (no channel configured, so it was logged and stays queued).
3. **E2E failure path:** removed `cv.md`. Result: doctor failed, classified `config`, alert produced, exit 1, `runs.jsonl` recorded. (That run predates skipping RCA for `config`; the code now skips it.)
4. **E2E Telegram:** a mock Bot API on `127.0.0.1:18999` via `TELEGRAM_API_BASE`. Verified:
   - the start message;
   - the `done:012` callback → `answerCallbackQuery` and the tracker row in `data/applications.md` flipped `Evaluated → Applied` through `set-status.mjs`;
   - `/pause` from a **foreign chat id was ignored**;
   - `/status` replied;
   - the ready message with the inline keyboard was sent.
5. `node validate-system-paths-coverage.mjs` → OK after adding `'scripts/loop/'`.
6. `node test-all.mjs --quick` → **16016 passed, 1 failed, 23 warnings.** The one failure is `archive-posting egress guard blocked a legitimate request` (an inline check in `test-all.mjs`, around line 2178, that resolves `example.com`). It is unrelated: this sandbox has no direct DNS, and `archive-posting.mjs` wasn't touched. **Re-run it in CI or on a normal machine to confirm.**

**Not tested:** a real Railway build and deploy, the real `claude` CLI in the container (auth, `IS_SANDBOX` plus root plus skip-permissions), the real Telegram API, the real email-alert relay, a real `scan.mjs` network run inside the container, data-repo restore and push against GitHub, autofix PR creation, and the quality of the prepare prompt's output on real postings.

---

## 8. Known issues, risks and TODOs (prioritized)

Fix §8.1-§8.4 before turning this on for real.

### 8.1 SECURITY: agent subprocesses inherit all secrets

`runStep()` spawns with `env: { ...process.env, ...env }`, so the `claude` runs, which read **untrusted job postings** with `--dangerously-skip-permissions`, can see:
- `GITHUB_TOKEN`
- `TELEGRAM_BOT_TOKEN`
- `ALERT_API_KEY`
- `ANTHROPIC_API_KEY`

A prompt-injected posting could exfiltrate them. **Fix:** build an allowlisted env for agent runs in `claude()` (`worker.mjs`, around line 97): `PATH`, `HOME`, `CAREER_OPS_DATA_DIR`, `TZ`, `PLAYWRIGHT_BROWSERS_PATH`, `IS_SANDBOX`, the Claude credential, and `NODE_*` as needed. Strip `GITHUB_TOKEN`, the Telegram and relay secrets, and `DATA_REPO`. Keep the token only for the worker's own `git` and `fetch` calls. Do the same for the `node scan.mjs` / `doctor.mjs` steps (lower risk, same fix). Also consider restricting the prepare run with `--allowedTools` instead of skip-permissions: Bash(node:*), Read, Write, Edit, Grep, Glob, WebFetch, WebSearch.

### 8.2 The prepare step's result isn't validated

`cycle()` treats exit 0 as success. It should parse the final JSON line (`{"evaluated","ready","skipped_below_gate","errors"}`):
- record it in `run`;
- treat a non-empty `errors` (or unparseable output) as a soft failure or warning;
- cross-check that every id in `ready` has a valid `ready/NNN.json`.

### 8.3 Concurrent git in the data root

`closeItem()` (Telegram ✅/⏭) calls `backupData()` while a cycle's `finally` may also be running `backupData()`, which can collide on `.git/index.lock`. **Fix:** a simple async mutex around `backupData()`, or have `closeItem()` only set a "dirty" flag.

### 8.4 Pin versions and verify container assumptions

- Pin `CLAUDE_CODE_VERSION` in `scripts/loop/Dockerfile` to an exact, at-least-two-weeks-old version instead of `latest`.
- Verify `IS_SANDBOX=1` really allows `--dangerously-skip-permissions` as root with that version. If not, add a non-root user (the Playwright image has `pwuser`) and make sure the Railway volume is writable by it.

### 8.5 Token spend isn't capped directly

`LOOP_DAILY_CAP` counts only **delivered** ready items. Evaluations that score below the gate don't count, so spend is roughly `LOOP_MAX_EVALS_PER_CYCLE × cycles/day` (up to 96/day at 30 min with 24 h active). **Add** `LOOP_DAILY_EVAL_CAP` (count from the prepare JSON's `evaluated`). A cheap zero-token pre-check that skips the agent call when `## Pending` has no eligible `- [ ]` lines would also help.

### 8.6 Health endpoint is always green

Make `/health` return 503 when the last successful cycle is older than about 3× the interval while not paused or outside active hours, so Railway and uptime monitors can see a stall. The `HEALTHCHECK_PING_URL` dead-man's switch covers this externally in the meantime.

### 8.7 Smaller items

- `state.notified` grows forever. Cap it to the last ~500 entries or prune ids whose ready file is closed.
- With no notification channel, items are never marked notified, so `LOOP_DAILY_CAP` never advances. Acceptable (startup warns), but consider failing fast at startup when neither channel is configured.
- `/ready` lists every file still in `ready/`, including items already sent but not acted on. That is intended, but the label could be clearer.
- The `/done` race: if the user taps ✅ for an item before `deliverReady` notified it (unlikely), the file is moved and never notified. Harmless.
- PDFs and reports pushed to the data repo grow it over time. Consider `git gc` or Git LFS, or excluding `output/` and regenerating on demand.
- The prepare prompt reads form questions via `prepare-application.mjs` (Greenhouse/Ashby/Lever only). Other ATSs get generic answers.
- **LinkedIn** postings are skipped: there is no browser MCP in the container, and the AGENTS.md LinkedIn guard applies.
- Optionally add `scripts/loop/worker.mjs` to the `AGENTS.md` "Main Files" table and/or `docs/SCRIPTS.md`. Check `tests/agent-docs-script-refs.test.mjs` if you reference it there.
- **Railway auto-deploy:** the autofix "merge to redeploy" flow assumes the Railway service tracks `CODE_BRANCH` with auto-deploy on. Document or verify that.

### 8.8 Ideas not built (only if the user asks)

- A remote browser (noVNC or Browserbase) so the user can submit a server-prefilled form from their phone. Big scope, and it must still never auto-submit.
- A cheaper scoring pass with an OpenRouter, Gemini or Ollama runner (`openrouter-runner.mjs`, `gemini-eval.mjs`, `ollama-eval.mjs` exist) before the Claude evaluation.
- A Telegram `/answer N <text>` command to fill `needs_you` items and update the report's `## Application Answers`.

---

## 9. Git and repository status

- **Local branch:** `claude/wonderful-ptolemy-n6qcg5`.
- **Commit:** `d853694 feat(loop): cloud apply loop on Railway with Telegram hand-off and RCA`, on top of `cd9ce14` (upstream `main` at the time). This handoff doc is in a follow-up commit.
- **Push failed:** HTTP 403. The session's GitHub app has no write access to `career-ops-hq/career-ops`, the **upstream** project rather than the user's fork.
- **Patch exported** (session scratchpad, may not survive the session): `/tmp/claude-0/-home-user-career-ops/375a7a2d-63c2-5e34-9f32-202351e8a8ac/scratchpad/0001-feat-loop-cloud-apply-loop-on-Railway-with-Telegram-.patch`.
- **To move the work:** fork `career-ops-hq/career-ops` to the user's account (e.g. `varindersingh83/career-ops`), then either start a session with the fork selected and push this branch, or `git am` the patch in the fork. Railway must deploy **the fork**.
- **Do not** put user data (cv.md, profile, tracker, reports) in the fork. It belongs in the private `DATA_REPO`.

---

## 10. Next-agent checklist (in order)

1. [ ] Get the code onto the user's fork (§9). Confirm `git log` shows the loop commit(s).
2. [ ] Run `npm install && node --test tests/cloud-loop.test.mjs && node validate-system-paths-coverage.mjs && node test-all.mjs --quick` on a machine with normal DNS. Everything should pass.
3. [ ] Fix **§8.1** (env allowlist for agent runs), then §8.2, §8.3 and §8.4. Add tests for each in `tests/cloud-loop.test.mjs`; keep logic in `scripts/loop/lib.mjs` so it stays testable. Update `docs/CLOUD_LOOP.md` and this file to match.
4. [ ] Optionally do §8.5 and §8.6.
5. [ ] Help the user with the one-time setup, following `docs/CLOUD_LOOP.md` → Setup:
   - a private data repo with `cv.md`, `config/profile.yml`, `modes/_profile.md`, `modes/_custom.md`, `portals.yml`, `data/`, `reports/`, `output/` (run `node doctor.mjs --json` against it locally with `CAREER_OPS_DATA_DIR=<path>` and get `onboardingNeeded:false`; if `unpersonalized` is non-empty, personalize `modes/_profile.md` first, per AGENTS.md);
   - recurring answers in `config/profile.yml` and house rules in `modes/_custom.md`;
   - a new Telegram bot and its chat ID;
   - a fine-grained GitHub PAT;
   - the Railway service from the fork: config path `scripts/loop/railway.json`, a volume at `/data`, and the Variables from `scripts/loop/.env.example`;
   - a healthchecks.io check with its Telegram integration.
6. [ ] **First live run:** send `/run`. Watch the Railway logs and `data/loop/runs.jsonl` in the data repo. Verify a real ready item arrives with the PDF, and that tapping ✅ after a real submit flips the tracker row.
7. [ ] Force a failure (e.g. temporarily break `portals.yml`) and verify the alert, the RCA file and the breaker. Only then consider `LOOP_AUTOFIX=1`.
8. [ ] Keep the never-submit rule intact in every change. `tests/cloud-loop.test.mjs` asserts it is in `prepare.md`; don't weaken that test.

---

## 11. Quick reference: commands

```bash
# one cycle locally against a data root
CAREER_OPS_DATA_DIR=/path/to/data node scripts/loop/worker.mjs --once

# fake agent + mock Telegram (as in §7)
LOOP_CLAUDE_BIN=/path/to/fake-claude TELEGRAM_API_BASE=http://127.0.0.1:18999 \
TELEGRAM_BOT_TOKEN=x TELEGRAM_CHAT_ID=999 PORT=18998 node scripts/loop/worker.mjs

# tests
node --test tests/cloud-loop.test.mjs
node validate-system-paths-coverage.mjs
node test-all.mjs --quick

# build the Railway image locally
docker build -f scripts/loop/Dockerfile -t career-ops-loop .
docker run --rm -e CAREER_OPS_DATA_DIR=/data/career-ops -v $PWD/.loopdata:/data career-ops-loop node scripts/loop/worker.mjs --once
```
