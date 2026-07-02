# #10721 / #10723 — live-LLM before/after: SCHEDULED_TASKS trigger boundary + duplicate guard

Same scenario (`brush-teeth-basic`), same live backend (`ELIZA_CHAT_VIA_CLI=claude`,
subscription CLI, no API key), run twice on this branch:

## Before (commit 7d62df0a57's proof run — `../10757-cli-live-lane/report.json`)

7 `SCHEDULED_TASKS_CREATE` calls across two turns:

| call | trigger shape the model emitted | result |
|---|---|---|
| 1 | `{type:"cron", schedule:"0 8,21 * * *"}` | ✗ bare `MISSING_TRIGGER` |
| 2 | `{kind:"cron", cron:"0 8,21 * * *"}` | ✗ unlabeled `success:false` (`expression.trim` throw inside the runner) |
| 3 | `{kind:"cron", expression:"0 8,21 * * *"}` | ✓ created `st_mr2kojdu_tklxawpk` |
| 4 | `{type:"cron", cron:"…"}` (new idempotencyKey) | ✗ `MISSING_TRIGGER` |
| 5 | `{type:"cron", cron:"…", timezone:"UTC"}` | ✗ `MISSING_TRIGGER` |
| 6 | `{kind:"cron", cron:"…", timezone:"UTC"}` | ✗ unlabeled `success:false` |
| 7 | `{kind:"cron", expression:"…", timezone:"UTC"}` | ✓ created `st_mr2kpqxg_i5k5zi23` — a **DUPLICATE** reminder |

Net: 5 failed calls burned as retries, and the user ended up with **two identical
brush-teeth reminders** under different idempotency keys. Scenario wall time 95s.

## After (`after-report.json`, commit 7273e0d981 + rebuilt dist)

1 `SCHEDULED_TASKS_CREATE` call:

| call | trigger shape the model emitted | result |
|---|---|---|
| 1 | `{type:"cron", cron:"0 8,21 * * *", timezone:"UTC"}` | ✓ normalized to `{kind:"cron", expression:"…", tz:"UTC"}`, created first try |

No retry churn, no duplicate. Scenario wall time 50.6s (was 95s).

## Honest residuals (scenario-content, not plumbing)

The scenario still reports `failed` on two content assertions:

1. `responseIncludesAny [brush teeth, brushing habit, set that up]` — the model said
   "Set up daily **brush-teeth** reminders at 8 AM and 9 PM." The hyphenated
   compound doesn't substring-match "brush teeth". Phrasing brittleness in the
   scenario (echo-family debt tracked under #9310's remaining 215).
2. `definitionCountDelta` expects a "Brush teeth" **habit definition** (the LIFE
   pipeline with streaks/windows); the live model routed to the generic
   `SCHEDULED_TASKS_CREATE` instead. Real finding: for habit-shaped requests the
   planner faces two overlapping surfaces (LifeOps definitions vs scheduled
   tasks) and picks the generic one. Action-description disambiguation is a
   product-level follow-up — noted in the campaign close-out rather than
   papered over by widening the assertion.

Exact command:

```bash
ELIZA_CHAT_VIA_CLI=claude ELIZA_PLANNER_NATIVE_TOOLS=0 ELIZA_CLI_TIMEOUT_MS=240000 \
  bun packages/scenario-runner/bin/eliza-scenarios run \
  plugins/plugin-personal-assistant/test/scenarios \
  --scenario brush-teeth-basic --report <out>/report.json --run-dir <out>/run
```

Gotcha for reproducers: the scenario runtime loads PA from `dist/` — rebuild
(`bun run --cwd plugins/plugin-personal-assistant build`) after changing `src/`
or the run proves the OLD code.

## Addendum — capability-purpose routing finding (live, #8795)

A live run of `inbox-triage-capability` (report at
`../../..`-scratch, planner trace in the run dir) routed to the promoted
`INBOX_LIST` subaction — which **bypasses the triage classifier**, the
`inbox_triage` optimized-prompt consumer. The run's trajectories carry
`planner`/`tool`/`messageHandler` stages but zero LifeOps capability purposes,
so `trajectories:review --dry-run` correctly reports 0 samples for all 8
capabilities.

Two consequences worth acting on (residuals for #8795):
1. The `*-capability.scenario.ts` files named for the optimization tasks do
   not necessarily exercise those tasks under a live model — the planner can
   satisfy the user via sibling subactions that skip the capability prompt.
   Their planner assertions also still expect umbrella action names
   (`inbox_action`) that promoted subactions (`INBOX_LIST`) no longer match.
2. Organic trajectory accumulation for the GEPA loop will under-sample
   capabilities whose flows the planner routes around; scenario-driven dataset
   seeding (the `lifeops:gepa-seed` path) remains the reliable source until
   action descriptions disambiguate the capability paths.
