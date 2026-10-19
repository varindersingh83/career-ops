# Cloud apply loop (Railway + Telegram)

Runs career-ops around the clock on a small Railway service, so it keeps working while your laptop is closed. Every 30 minutes it:

1. **Scans** your portals for new postings (every 6 h by default; zero tokens).
2. **Evaluates** the best-fitting pending role (up to 2 per cycle) and writes the report, the archived JD and the tracker row.
3. **Prepares** one application when a role scores ≥ 4.0/5: tailored CV PDF plus drafted form answers.
4. **Sends it to Telegram** with the apply link, the PDF, the drafted answers, and anything it needs from you.

**You submit.** Open the link, paste the answers, click Submit, then tap **✅ I submitted it**. The tracker row moves to `Applied`. The loop never clicks Submit and never marks anything Applied on its own (AGENTS.md → Ethical Use). Ashby and Lever block automated submits anyway.

When a step fails, the loop:

- **classifies** the failure: `config` (missing CV, bad auth), `transient` (network, rate limit), `timeout`, or `code` (a script crashed);
- **writes an RCA** using a read-only agent run, saves it to `data/loop/rca/`, and sends it to Telegram;
- **opens an autofix pull request** on your fork when the RCA says a small code change fixes it (`LOOP_AUTOFIX=1`, at most one per bug per day). It never merges anything: you review the PR and merge it, and Railway redeploys;
- **pauses** after 3 consecutive failures, so it doesn't keep spending tokens on the same failure, and tells you. Send `/resume` once it's fixed.

```
 every 30 min ─► doctor ─► scan (6h) ─► evaluate+prepare (claude -p) ─► Telegram ─► you submit ─► ✅ → Applied
                    │           │                 │
                    └──── failure ────────────────┘
                              ▼
                 classify → RCA (read-only) → Telegram alert
                              ├─► autofix PR on your fork (opt-in) ─► you merge ─► redeploy
                              └─► 3 in a row → pause until /resume
```

## Cost

| Item | Rough monthly cost |
|---|---|
| Railway Hobby (one service + 1 GB volume) | ~$5 (the plan includes $5 of usage; the worker idles between cycles) |
| Claude | Your Pro/Max plan via `CLAUDE_CODE_OAUTH_TOKEN` (no extra cost, but subject to plan limits), or API tokens at roughly $0.30–1.00 per evaluation |
| Telegram, healthchecks.io | free |

Token spend is bounded by `LOOP_MAX_EVALS_PER_CYCLE` × cycles in your active hours, and preparing stops at `LOOP_DAILY_CAP`. A cycle with nothing new pending costs one short agent call.

## Setup (≈20 minutes)

### 1. A private data repo

Your CV and tracker must never go in a public repo. Create a **private** GitHub repo, e.g. `you/career-ops-data`, laid out like a data root (see DATA_CONTRACT.md):

```
cv.md
config/profile.yml
modes/_profile.md
modes/_custom.md        (optional house rules — see below)
portals.yml
data/                   (applications.md, pipeline.md, … — can start empty)
reports/  output/
```

If you already use career-ops locally, copy those files over from your checkout. The loop restores this repo onto the Railway volume on first boot and commits its changes back after every cycle, so the repo is also your backup and your view of what the loop did.

### 2. Answer the recurring questions once

The questions the agent keeps asking you belong in your files, so the loop can answer them:

- `config/profile.yml`: work authorization/sponsorship, salary target, notice period, relocation, location policy.
- `modes/_custom.md`: standing rules, e.g. *"Never answer EEO/demographic questions. For 'why this company', draft from report Block A in 3 sentences. Skip roles requiring on-site outside the Bay Area."*

Anything the loop can't back with a source shows up under **⚠️ Needs your input** in the Telegram message. It never guesses.

### 3. Telegram

Create a **new bot just for this loop** with [@BotFather](https://t.me/BotFather) (`/newbot`). Don't reuse the bot behind an existing poller, because Telegram allows only one `getUpdates` consumer per bot. Send your new bot any message, then get your chat ID, for example with `get_chat_id.py` from your email-alert repo.

**Optional:** if you already run the [email-alert](https://github.com/varindersingh83/email-alert) service, set `ALERT_API_URL`, `ALERT_API_KEY` and `ALERT_DESTINATION` too. Failure alerts then fall back to its durable, retried queue if a direct bot call fails. Relay-only works as well (leave the bot variables empty), but then there are no buttons or commands.

### 4. A GitHub token

Create a fine-grained personal access token limited to your data repo and your career-ops fork, with **Contents: read/write** and **Pull requests: read/write**. The worker sends it as a per-command header and never writes it to `.git/config`.

### 5. Deploy on Railway

1. Fork career-ops (or use your existing fork).
2. In Railway, create a project, choose **Deploy from GitHub repo**, and pick your fork.
3. Under service **Settings**, set **Config-as-code path** to `scripts/loop/railway.json`. This builds `scripts/loop/Dockerfile`, restarts the service on any exit, and health-checks `/health`.
4. Add a **Volume** mounted at `/data`.
5. Under **Variables**, add the entries from [`scripts/loop/.env.example`](../scripts/loop/.env.example). The minimum set is:
   - a Claude credential: `CLAUDE_CODE_OAUTH_TOKEN` (run `claude setup-token` locally) or `ANTHROPIC_API_KEY`;
   - `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`;
   - `GITHUB_TOKEN` and `DATA_REPO`;
   - `TZ`, for example `America/Los_Angeles`.
6. Deploy. You should get **"▶️ career-ops loop started"** on Telegram. Send `/run` to trigger the first cycle right away.

### 6. A dead-man's switch (recommended)

Railway restarts a crashed process, but nothing warns you if the whole service stops. Create a free check at [healthchecks.io](https://healthchecks.io) with a 1-hour period (longer if you set `LOOP_ACTIVE_HOURS`), connect its Telegram integration, and set `HEALTHCHECK_PING_URL`. Each successful cycle pings it and each failed one pings `/fail`, so you hear about it even when Railway itself is down.

## Telegram commands

| Command | What it does |
|---|---|
| `/status` | Paused/running, failures in a row, prepared today, last run |
| `/ready` | Applications waiting on you |
| `/run` | Run a cycle now |
| `/done N` (or the ✅ button) | Mark report N `Applied`. Use it only after you submitted |
| `/skip N` (or the ⏭ button) | Mark report N `Discarded` |
| `/pause` · `/resume` | Stop/restart scheduled cycles (`/resume` also resets the failure count) |

The bot only obeys `TELEGRAM_CHAT_ID` and ignores every other chat. Every evening at `LOOP_SUMMARY_HOUR` it sends a daily summary.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `LOOP_INTERVAL_MIN` | 30 | Minutes between cycle starts (min 5) |
| `LOOP_SCAN_EVERY_HOURS` | 6 | How often to run `scan.mjs` |
| `LOOP_MAX_EVALS_PER_CYCLE` | 2 | Full evaluations allowed per cycle while looking for one good role |
| `LOOP_DAILY_CAP` | 8 | Applications prepared per day, max |
| `LOOP_SCORE_GATE` | 4.0 | Minimum score to prepare an application |
| `LOOP_ACTIVE_HOURS` | (always) | e.g. `7-23` in `TZ`; `22-6` wraps midnight |
| `LOOP_SUMMARY_HOUR` | 20 | Local hour for the daily summary |
| `LOOP_BREAKER_THRESHOLD` | 3 | Consecutive failures before pausing |
| `LOOP_STEP_TIMEOUT_MIN` | 25 | Hard timeout per step |
| `LOOP_RCA` | 1 | Write an RCA for failures (not for `config` ones, which explain themselves) |
| `LOOP_AUTOFIX` | 0 | Open an autofix PR on `CODE_REPO` for `code` failures |
| `LOOP_MODEL` | (CLI default) | Passed to `claude --model` |
| `LOOP_CLAUDE_ARGS` | `--dangerously-skip-permissions` | Flags for the prepare/autofix agent runs. The container is isolated and its runs are bounded by the prompt rules; RCA runs always use read-only tools |

## Files the loop writes (in your data repo)

- `data/loop/state.json`: pause flag, failure count, what was already sent
- `data/loop/runs.jsonl`: one line per cycle (steps, durations, failure class)
- `data/loop/rca/*.md`: one RCA per failed run
- `data/loop/ready/*.json`: applications waiting on you; moved to `ready/closed/` after ✅/⏭

## Limits

- **LinkedIn** postings are skipped. They need a logged-in browser, and the loop keeps them `[!]` in `pipeline.md` per the LinkedIn guard in AGENTS.md. Evaluate those locally.
- **Form questions** are read from the ATS page or API (Greenhouse, Ashby, Lever via `prepare-application.mjs`). For other ATSs the answers cover the usual questions, and you may meet an extra field or two when you open the form.
- **Maintainers / next agent:** design notes, decisions, known issues and the TODO checklist are in [CLOUD_LOOP_HANDOFF.md](CLOUD_LOOP_HANDOFF.md).
- **Run it locally:** `node scripts/loop/worker.mjs --once` runs one cycle against your data root and exits non-zero on failure.
