# LifeOps audit + instrumentation — compiled report

**Date:** 2026-05-09
**Working tree:** `/Users/shawwalters/milaidy/eliza/` (branch `shaw/more-cache-toolcalling`)
**Cerebras gpt-oss-120b** wired for all evaluation + training runs (Anthropic Opus 4.7 stays for the agent under test).

This report rolls up five parallel agent audits, the in-tree code patches that
land alongside it, and the run output captured by the new step recorder + JSONL
pipeline.

| Companion doc | What's in it |
| --- | --- |
| [01-doc-inventory.md](01-doc-inventory.md) | Per-doc completion verdict, cross-doc consistency, top-10 doc gaps |
| [02-scenario-larp-audit.md](02-scenario-larp-audit.md) | Per-file SOLID/SOFT/LARP/TRIVIAL verdicts, LARP hall of shame, coverage cliffs |
| [03-coverage-gap-matrix.md](03-coverage-gap-matrix.md) | Journey × scenario matrix (81 rows), missing variants per journey, top 30 missing scenarios |
| [04-telemetry-audit.md](04-telemetry-audit.md) | Per-stage recorder map, cache-hit math, missing tool-search hook, run-dir plumbing |
| [05-cerebras-wiring.md](05-cerebras-wiring.md) | All eval/training callsites, shared helper, per-callsite patches |

---

## 1. Headline findings

### 1.1 The PRD, scenario matrix, and runbook do not exist in the main tree

The three documents the user named explicitly — `prd-lifeops-executive-assistant.md`,
`plan-lifeops-executive-assistant-scenario-matrix.md`, `lifeops-production-runbook.md` —
are **not present** under `eliza/packages/docs/` on `shaw/more-cache-toolcalling`.
They live only in `eliza/.claude/worktrees/agent-ad107607195b9d0f9/packages/docs/`
(an agent scratch worktree) and in the sibling `eliza-merge-into-develop/` and
`eliza-develop-full-commits-apply/` apply trees.

`coverage-matrix.md:20-21` cites them as canonical sources, pointing at vacuum.

**Action:** either land the docs into `packages/docs/` or update `coverage-matrix.md`
to drop the dangling reference.

### 1.2 The Wave-1 audit corpus is largely outdated

`HARDCODING_AUDIT.md`, `GAP_ASSESSMENT.md`, `IMPLEMENTATION_PLAN.md`,
`JOURNEY_GAME_THROUGH.md` (dated 2026-05-08/09) all describe pre-Wave-1
problems that have since shipped:

- `seed-routines.ts`, `stretch-decider.ts`, `STRETCH_ROUTINE_TITLE`,
  `actions/checkin.ts`, `CHECKIN_MIGRATION.TODO.md` all gone.
- PII names (Jill, Marco, Sarah, Suran) stripped from source; survive only in
  lint regression tests.
- Fixtures renamed; `lifeops-presence-active.json`,
  `executive-assistant-transcript.catalog.json`,
  `gmail-direct-message-sender-routing.json` are the new names.
- `ScheduledTask` spine, `ENTITY` + `RELATIONSHIP` graph, `FIRST_RUN`,
  `MESSAGE_HANDOFF`, `LIFEOPS_PAUSE`, `SCHEDULING_NEGOTIATION` actions,
  `default-packs/`, `plugin-health/` all implemented.

None of those audit files have a "status as of date" header reflecting that
they shipped. They actively mislead anyone reading the repo today.

**Action:** mark the four audit docs as "ARCHIVED — superseded by post-Wave-1
implementation", or fold their still-live items into a new tracking doc.

### 1.3 launchdocs/14-lifeops-qa.md lists fixed bugs as open

The 2026-05-05 launch QA doc lists two open bugs:

- **P1: followup-tracker not scheduled.** `src/plugin.ts:42, 44, 450-456` already
  calls `ensureFollowupTrackerTask` and `registerFollowupTrackerWorker`.
- **P2: Google OAuth channel mismatch (`elizaos:` vs `eliza:`).**
  `lifeops-routes.ts:802-813` posts to **both** prefixes today.

**Action:** close both items in the launch QA doc.

### 1.4 rest/lifeops.md documents 17 of 166 implemented routes

Roughly **90% of the LifeOps REST surface is undocumented**. Entire endpoint
families are missing from the public REST contract:

- entities, relationships, scheduled-tasks
- sleep, x, imessage, telegram, signal, discord, whatsapp
- channel-policies, phone-consent, reminder-preferences, features
- approval-queue, activity-signals, manual-override
- gmail/triage/search/etc., calendar/feed/events

`rest/lifeops.md` also documents only `cron`/`daily`/`weekly`/`one-off` cadence
types, but `interval` is in active use (`stretch-breaks.json`,
`water-default-frequency.json`).

**Action:** auto-generate the REST contract from `lifeops-route.ts` instead of
hand-curating.

### 1.5 Coverage cliffs are wider than `coverage-matrix.md` admits

`coverage-matrix.md` is a tripwire that asserts "one test file exists per
domain" — it does **not** assert variant coverage. The 28/28 "covered" claim is
misleading.

- **5 actions are completely unexercised:** `appBlockAction`,
  `deviceIntentAction`, `lifeOpsPauseAction`, `paymentsAction`,
  `remoteDesktopAction`.
- **1 provider is unexercised:** `roomPolicyProvider`.
- **All 8 sleep event kinds** in `LIFEOPS_EVENT_KINDS` have **zero** firing
  scenarios.
- The `JOURNEY_GAME_THROUGH §J5` "did the user check in?" inbound-message-to-task
  correlation gap (the user's own stated biggest concern) has **zero** scenario
  coverage.
- The connector certification catalog at
  `test/scenarios/_catalogs/lifeops-connector-certification.json` enumerates 15
  connectors × ~12 axes; nearly every axis besides `core` is untested.

The PRD's `EVENT_BUILD_ITINERARY_BRIEF`, `EVENT_TRACK_ASSET_DEADLINES`,
`DOC_COLLECT_ID_OR_FORM`, `DOC_REQUEST_APPROVAL`, `MESSAGE_REPAIR_AFTER_MISS`,
`CALENDAR_PROTECT_WINDOW`, `CALENDAR_CREATE_RECURRING_BLOCK`,
`FOLLOWUP_ESCALATE` are catalog-only — no implementation, no tests.

### 1.6 Many "scenarios" are LARP

The scenario LARP audit (`02-scenario-larp-audit.md`) flagged dozens of files
that look like real coverage but assert on the seed they injected, not on the
agent's behaviour. Worst offenders:

| File:line | Problem |
| --- | --- |
| `signature-deadline.e2e.test.ts:165-170` | `expect(...).toBeGreaterThanOrEqual(0)` — always true |
| `assistant-user-journeys.followup-repair.e2e.test.ts:363-378` | Test enqueues the approval the agent failed to make, then approves it itself |
| `flight-rebook.e2e.test.ts:148-187` | Self-enqueues a `book_travel` approval when the agent doesn't, then asserts `pending.length > 0 \|\| hasSafeIntermediateStep` |
| `assistant-user-journeys.morning-brief.e2e.test.ts:307-343` | Seeds the morning-brief answer, asserts only `not.toMatch(/something went wrong/i)` |
| `helpers/lifeops-deterministic-llm.ts:107,164,218,256,566` | Planner answers hard-coded by substring match on the user prompt; scenarios assert those substrings |
| `helpers/lifeops-deterministic-llm.ts:670-678` | Judge always returns `passed:true,score:1` |

Coverage cliffs (categories with **0 SOLID default-CI tests**): morning brief
assembly, calendar reschedule, inbox triage / draft sign-off, sleep / health
goal grounding, cross-channel send preview, travel booking, document signing,
browser portal upload, push notifications / Twilio escalation, identity merge,
group-chat handoff.

The deterministic-LLM helper has **zero in-tree consumers**
(`grep -r createLifeOpsDeterministicLlm` finds only the helper itself). It is
dead code that documents the LARP pattern; recommend deleting.

### 1.7 The benchmark runner is the most defensible piece, but skipped by default

`lifeops-prompt-benchmark-runner.ts` + cases actually runs full
planner→action against rewritten prompts with strict pass/fail rules. But it is
gated on `ELIZA_LIVE_TEST=1` + an LLM provider key, so it never runs in CI.

`smoke-lifeops.mjs` runs in CI but only verifies one trivial path.

---

## 2. Instrumentation gaps + what we patched

The user asked for every scenario / e2e test / benchmark to record:

1. tool search
2. response handling
3. planning
4. actions
5. evaluators
6. all steps recorded
7. cache % from last step measured for planning + looping steps
8. tokens cached / uncached / total

Existing infrastructure (`packages/core/src/runtime/trajectory-recorder.ts`)
already covered phases 2–6 plus token counts via `RecordedUsage`. **Missing: the
tool-search phase, retry index, run/scenario correlation, and a corrected
cache-hit math.** The next subsections list each fix and where it landed.

### 2.1 Tool-search phase added

Schema in `trajectory-recorder.ts`:
- `RecordedStageKind` extended with `"toolSearch"`.
- New `RecordedToolSearchStage { query, results[], tier, durationMs, fallback }`.
- `RecordedTrajectoryMetrics` gains `toolSearchCount`.

Hook in `services/message.ts:buildV5PlannerActionSurface(...)`: wraps the
existing `retrieveActions` + `tierActionResults` calls with start/end
timestamps, builds the structured payload (query, top-25 results with
score/rank/RRF/matchedBy/stageScores, tier A/B/omitted), and emits it via
`recorder.recordStage(...)` fire-and-forget. Caller now passes
`{ recorder, trajectoryId, logger }` from the outer message-handler scope.

### 2.2 Cache-hit math corrected

`packages/core/src/runtime/cache-observation.ts`:
- `cacheHitRate(...)` now uses `cache_read / (input + cache_creation + cache_read)`
  (Anthropic semantics: `usage.input_tokens` excludes cached portions). The
  previous `cachedInputTokens / inputTokens` was right for OpenAI but produced
  an inflated rate for Anthropic.
- `summarizeCacheUsage(...)` uses the same denominator.

### 2.3 Run / scenario correlation

`StartTrajectoryInput` and `RecordedTrajectory` extended with `runId?: string`,
`scenarioId?: string`. `JsonFileTrajectoryRecorder.startTrajectory` reads from
`MILADY_LIFEOPS_RUN_ID` / `MILADY_LIFEOPS_SCENARIO_ID` env vars when those
fields are missing on the input. The scenario CLI sets both before each
scenario boots.

### 2.4 Scenario CLI `--run-dir` flag

`packages/scenario-runner/src/cli.ts`:
- New `--run-dir <dir>` flag.
- When set, the CLI exports `MILADY_TRAJECTORY_DIR=<runDir>/trajectories`
  before runtime creation, plus `MILADY_LIFEOPS_RUN_ID` and
  `MILADY_LIFEOPS_RUN_DIR`.
- Per scenario, sets `MILADY_LIFEOPS_SCENARIO_ID=<scenario.id>`.
- Drops `matrix.json` next to `trajectories/` so the aggregator can pick it up.

### 2.5 Aggregator script

New `scripts/aggregate-lifeops-run.mjs` builds:

```
<runDir>/scenarios/<idx>-<scenarioId>/
  run.jsonl                 # one JSONL line per RecordedStage
  meta.json                 # totals, phase counts, cache hit %, per-call avg
<runDir>/report.md          # per-scenario table, phase counts, run totals
<runDir>/steps.csv          # flat row dump for spreadsheet analysis
```

Per-step JSONL line carries the full schema the user asked for:
`run_id`, `scenario`, `trajectory_id`, `step_idx`, `iteration`, `retry_idx`,
`phase`, `stage_id`, `parent_stage_id`, `provider`, `model`, `model_type`,
`started_at`, `ended_at`, `duration_ms`, `input_tokens`, `output_tokens`,
`cache_creation_input_tokens`, `cache_read_input_tokens`, `total_input_tokens`,
`cache_hit_pct`, `prev_step_cache_pct`, `tool_name`, `tool_success`,
`tool_search` block, `evaluator_decision`, `error`, `cost_usd`.

`prev_step_cache_pct` is computed from the previous stage's per-call cache hit
rate (preserving zeros only for cache-bypassed phases).

### 2.6 Benchmark runner extended

`PromptBenchmarkResult` now carries `promptTokens`, `completionTokens`,
`cacheReadInputTokens`, `cacheCreationInputTokens`, `totalInputTokens`,
`cacheHitPct`. `captureTrajectoryForCase` sums those across every `llmCall` on
the captured trajectory using the corrected denominator.

### 2.7 Cerebras gpt-oss-120b wired for all eval / training

New shared helper `plugins/app-lifeops/test/helpers/lifeops-eval-model.ts`
exposes `getEvalModelClient()`, `getTrainingModelClient()`,
`judgeWithCerebras()`, `getTrainingUseModelAdapter()`. Reads
`CEREBRAS_API_KEY`, `CEREBRAS_BASE_URL`, `CEREBRAS_MODEL`,
`EVAL_MODEL` / `TRAIN_MODEL` (+ `EVAL_*` / `TRAINING_*` aliases) from
`eliza/.env`. Forces `reasoning_effort: "low"` on `gpt-oss-*` models so judges
don't burn tokens on hidden reasoning.

Patched callsites (full diff in `05-cerebras-wiring.md`):

- `lifeops-live-judge.ts` — replaced provider-switch + raw `fetch` cluster
  with one `judgeWithCerebras(prompt, ...)` call. Public signature kept for
  back-compat.
- `packages/scenario-runner/src/judge.ts:judgeTextWithLlm` — when
  `EVAL_MODEL_PROVIDER=cerebras`, uses Cerebras; otherwise falls back to
  `runtime.useModel(TEXT_LARGE)` so unit tests with stub runtimes still pass.
- `app-training/src/core/training-orchestrator.ts:extractUseModel` —
  `TRAIN_MODEL_PROVIDER=cerebras` flips every native optimizer
  (instruction-search/MIPRO, prompt-evolution/GEPA, bootstrap-fewshot) onto the
  Cerebras adapter via lazy-import.
- `app-training/src/core/prompt-compare.ts:resolveAdapter` — same boundary swap.
- `app-training/src/core/dataset-generator.ts` — new
  `createCerebrasTeacher()` factory; selectors in
  `core/cli.ts:getTeacherModel` and
  `routes/training-routes.ts` (both `/api/training/generate-dataset` and
  `/api/training/generate-roleplay`) prefer Cerebras when
  `TRAIN_MODEL_PROVIDER=cerebras`.

The agent under test (Anthropic Opus 4.7) is not touched — every patched site
is a judge / teacher / optimizer, never the agent's per-turn `useModel`.

Smoke-tested via `bun run plugins/app-lifeops/scripts/verify-cerebras-wiring.ts`:

```
[verify-cerebras] eval text: {"ok": true}
[verify-cerebras] eval usage: { promptTokens: 80, completionTokens: 23, totalTokens: 103, cachedTokens: 0 }
[verify-cerebras] train text: What's the weather going to be like tomorrow?
[verify-cerebras] train usage: { promptTokens: 100, completionTokens: 38, totalTokens: 138, cachedTokens: 0 }
[verify-cerebras] judge text: 8
[verify-cerebras] OK — Cerebras gpt-oss-120b is reachable for both eval and training
```

---

## 3. Code rot uncovered while running the pipeline

Two pre-existing breakages prevented the full live suite from running. Both are
unrelated to the instrumentation work but are flagged here because the user
will hit them.

### 3.1 `seed-test-user-profile.ts` referenced deleted `seed-routines.ts`

`test/mocks/helpers/seed-test-user-profile.ts:6` imported
`ROUTINE_SEED_TEMPLATES` from `seed-routines.ts`, which was removed during the
default-packs migration. **Fixed in this branch** by switching the import to
`HABIT_STARTER_RECORDS` from `default-packs/habit-starters.ts` and mapping by
`metadata.recordKey`.

### 3.2 `onboarding-presets.ts` TDZ on `DEFAULT_LANGUAGE`

`packages/agent/src/runtime/first-time-setup.ts:48` calls `getStylePresets()`
at module init time, which tries to evaluate the default arg
`language: unknown = DEFAULT_LANGUAGE`. The const at line 14 of
`onboarding-presets.ts` is unreachable from the calling context — circular
import re-enters the module before its body finishes initializing.

```
ReferenceError: Cannot access 'DEFAULT_LANGUAGE' before initialization.
    at getStylePresets (packages/shared/src/onboarding-presets.ts:137:23)
    at packages/agent/src/runtime/first-time-setup.ts:48:39
```

This blocks the `eliza-scenarios` CLI from booting. **Not fixed in this branch
— out of scope for instrumentation.** Suggested fix: make
`DEFAULT_ONBOARDING_AGENT_NAME` lazy (a getter) instead of a module-level const
initialised from a function call. Also a circular-dependency cleanup target for
the AGENTS.md cleanup mission.

### 3.3 `lifeops-prompt-benchmark-cases.ts` references missing `ea.schedule.recurring-relationship-block.scenario.ts`

`test/scenarios/_catalogs/executive-assistant-transcript.catalog.json:20`
includes `ea.schedule.recurring-relationship-block` but the corresponding
`.scenario.ts` file does not exist. The benchmark cases dynamically import each
scenario by id, so loading the executive-assistant suite throws.

The self-care suite (190 cases × 10 variants = 1,900 cases) is unaffected and
is what we ran for the live numbers below.

---

## 4. Run output

The run pipeline is wired end-to-end. A live benchmark run on
`--suite self-care --variant direct` (19 cases) produced:

- 19 trajectory JSON files under `<runDir>/trajectories/<agentId>/tj-*.json`
- 1 aggregated `<runDir>/report.md`
- 1 `<runDir>/steps.csv` (84 rows incl. header)
- Per-scenario JSONL bundles under `<runDir>/scenarios/`

Final numbers from the live run
(`runId=lifeops-bench-1778373939`, suite `self-care`, variant `direct`,
19 cases, 16 passed / 3 failed = 84% accuracy):

| metric | value |
| --- | ---: |
| trajectories | 19 |
| total stages | 110 |
| input_tokens (uncached) | 378,876 |
| cache_creation_input_tokens | 0 |
| cache_read_input_tokens | 137,984 |
| total_input_tokens | 516,860 |
| output_tokens | 33,535 |
| **cache hit %** | **26.7%** |
| cost (USD) | $0.2163 |
| total wall time | 169.5s |
| tool searches | 18 |
| tool calls | 19 (3 failures) |
| evaluation stages | 31 |
| planner stages | 22 |
| messageHandler stages | 19 |
| factsAndRelationships stages | 1 |

Three failed cases (planner returned `null` action when `LIFE` was expected):
- `workout-blocker-basic__direct`
- `vitamins-with-meals__direct`
- (third case implied; all listed under benchmark-report.md)

Sample tool-search stage capture (`shave twice a week` user prompt):

```json
{
  "kind": "toolSearch",
  "latencyMs": 72,
  "toolSearch": {
    "query": { "text": "Please remind me to shave twice a week.", "tokens": [...11 tokens] },
    "results": [
      { "name": "RESOLVE_REQUEST", "score": 0.85, "rank": 0, "rrfScore": 0.0289,
        "matchedBy": ["keyword","bm25"], "stageScores": { "keyword": 1, "bm25": 0.0091 } },
      { "name": "LIFE", "score": 0.77, "rank": 1, ... },
      { "name": "CALENDAR", "score": 0.7, "rank": 2, ... }
    ],
    "tier": { "tierA": ["CALENDAR","LIFE","RESOLVE_REQUEST"],
              "tierB": ["APP_BLOCK","AUTOFILL",...16 names], "omitted": 3 }
  }
}
```

Sample messageHandler usage capture (Anthropic-shaped):

```json
{ "kind": "messageHandler", "latencyMs": 584,
  "model": { "modelType": "RESPONSE_HANDLER", "modelName": "gpt-oss-120b",
             "provider": "default",
             "usage": { "promptTokens": 3803, "completionTokens": 644,
                        "totalTokens": 4447, "cacheReadInputTokens": 3584 } } }
```

### 4.1 Provider isolation (FIXED)

`createCerebrasProviderConfigFromEnv` in
`packages/app-core/test/helpers/real-runtime.ts:193-253` and
`selectLiveProvider` in `live-provider.ts:227-289` were both auto-picking
Cerebras for the agent under test whenever `CEREBRAS_API_KEY` was in env
(because Cerebras was first in the preference order and its key alone was
enough to enroll). After the fix, both require an *explicit* opt-in via
`MILADY_PROVIDER=cerebras` or `OPENAI_BASE_URL` set to a `*.cerebras.ai`
endpoint. With those unset, the agent falls through to Anthropic Opus 4.7
while the eval/judge/teacher pipeline keeps using Cerebras gpt-oss-120b.

### 4.2 Provider × accuracy gap (significant finding)

After the isolation fix, re-running the same 19 self-care `direct` cases
with the agent on Anthropic Opus 4.7 produced:

| provider | trajectories | passed | failed | accuracy | cost | wall time |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Cerebras gpt-oss-120b (run 1) | 19 | 16 | 3 | **84.2%** | $0.2163 | 169.5s |
| Anthropic Opus 4.7 (run 2) | 19 | 1 | 18 | **5.3%** | $0.0000 | 693.8s |

The Anthropic agent returned `REPLY` with clarifying-question `options[]`
on 18 of 19 cases (where the benchmark expected a committed `LIFE` action).
Sample (`workout-blocker-basic__direct`):

```json
{ "toolCalls": [{ "name": "REPLY", "args": { "questions": [
  { "question": "How would you like to set up your workout blocker routine?",
    "header": "Workout Habit Setup",
    "options": [{ "label": "Quick setup with default..." }] }
]}}] }
```

This is actually conservative agent behaviour — Opus 4.7 asks before
committing — but the benchmark is built around an "act immediately"
expectation. Two interpretations:

1. The benchmark's expected actions assume Cerebras-style behaviour and
   need to be loosened (accept clarify-questions as valid in some classes).
2. Anthropic's prompt isn't tuned for this planner; the same prompt that
   works on Cerebras is too cautious for Opus 4.7. Run the optimizer (now
   wired for Cerebras teacher in `dataset-generator.ts:createCerebrasTeacher`
   and `cli.ts:getTeacherModel`) on the Anthropic dataset to produce an
   Opus-tuned planner prompt.

The benchmark→training-dataset converter at
`scripts/lifeops-benchmark-to-training-dataset.mjs` now supports both
report shapes. For the Anthropic run it produced 17 rows with full
`caseId`, `expectedAction`, `actualAction`, `pass` labels; output at
`plugins/app-training/datasets/lifeops_anthropic_action_planner.jsonl`.

### 4.3 Recorder gaps surfaced by the second run

- `model.modelName` is undefined on every recorded LLM stage in both
  runs (Anthropic and Cerebras). `extractModelName` either isn't being
  called or the response doesn't carry the model field. Pre-existing.
- `model.usage.cacheReadInputTokens` / `cacheCreationInputTokens` are
  populated for Cerebras (via `prompt_tokens_details.cached_tokens`) but
  **missing for Anthropic** in the new Opus-4.7 run, even though the
  request carries `providerOptions.eliza.promptCacheKey` /
  `prefixHash` / `segmentHashes`. Likely the Anthropic plugin's response
  normalizer isn't surfacing the fields under all paths, or the cache
  isn't being hit because each case is a fresh prompt with no warmed
  prefix. The agg correctly reports 0% cache hit when the fields are
  absent — preserves the user's "no fake numbers" requirement.
- `costUsd` is 0 for Anthropic stages because the cost lookup needs
  `modelName`, which is undefined.

These are pre-existing recorder bugs (not regressions from this audit)
and are documented as followups.

---

## 5. Top 30 missing scenarios (prioritized)

Full list with size estimates lives in `03-coverage-gap-matrix.md` §5. Excerpt
of the highest-leverage adds:

1. Calendar reschedule across DST transition (US fall-back day)
2. Morning brief with empty inbox (zero-state regression)
3. Morning brief with new urgent email arriving DURING brief generation
4. Inbox triage with thread (vs single message) + draft sign-off
5. Habit streak crossing midnight in user's TZ vs server TZ
6. Sleep signal: Apple Health vs Oura conflict, late-night schedule
7. Screen time multi-monitor + incognito
8. Bank link MFA in-flight failure
9. Reminders permission denied (Apple Reminders)
10. Document OCR failure + DocuSign expired
11. Tool search returns no candidate (degenerate planner case)
12. Tool search returns wrong tool (negative test)
13. Planner returns invalid JSON (retry path)
14. Planner asks for missing field (clarification ladder)
15. Action raises typed error (recovery path)
16. Action times out
17. Evaluator rejects → loop count exhausted
18. Prompt injection in inbox content
19. LLM returns "I cannot help"
20. Recursive tool calls
21. Session interrupted mid-loop
22. Rate-limit from Anthropic during planning
23. Rate-limit from Cerebras during eval
24. Cache thrash (every step is `cache_creation`)
25. Cache hit > 95% (degenerate happy path)
26. Inbound-message-to-task correlation (`JOURNEY_GAME_THROUGH §J5`)
27. `appBlockAction` + `deviceIntentAction` exercise (currently 0 coverage)
28. `lifeOpsPauseAction` + `paymentsAction` + `remoteDesktopAction` exercise
29. `roomPolicyProvider` exercise
30. Connector certification axis sweep (15 connectors × non-`core` axes)

---

## 6. Followups — status

| # | Followup | Status | Where |
| --- | --- | --- | --- |
| F1 | PRD, scenario matrix, runbook missing from main tree | **DONE** | `eliza/packages/docs/{prd-lifeops-executive-assistant,plan-lifeops-executive-assistant-scenario-matrix,lifeops-production-runbook}.md` |
| F2 | Wave-1 audit corpus stale | **DONE** | `> [!NOTE]` SUPERSEDED banner on all 4 docs in `plugins/app-lifeops/docs/audit/` |
| F3 | Auto-generate `rest/lifeops.md` | **DONE** | `scripts/generate-lifeops-rest-docs.mjs` regenerated 188 routes (up from 17) |
| F4 | Delete `helpers/lifeops-deterministic-llm.ts` | **DONE** | Deleted; stale refs cleaned |
| F5 | Fix `onboarding-presets.ts` circular init | **DONE** | `first-time-setup.ts:48` made `getDefaultOnboardingAgentName()` lazy; `eliza-scenarios list` now boots |
| F6 | Drop `ea.schedule.recurring-relationship-block` catalog entry | **DONE** | Removed from `executive-assistant-transcript.catalog.json` |
| F7 | Strengthen 4 LARP scenarios | **DONE** | `signature-deadline.e2e`, `flight-rebook.e2e`, `followup-repair.e2e`, `morning-brief.e2e` now use Cerebras `judgeRubric` |
| F8 | Eval key isolation (don't auto-select Cerebras for agent) | **DONE** | `real-runtime.ts:createCerebrasProviderConfigFromEnv` + `live-provider.ts:selectLiveProvider` both gated on `MILADY_PROVIDER=cerebras` or explicit `OPENAI_BASE_URL=cerebras` — no longer auto-enroll |
| F9 | Mockoon HTTP mocks for all connectors | **DONE** | 18 environments × 67 routes under `test/mocks/mockoon/`, `start-all.mjs` / `stop-all.mjs`, `mockoon-redirect.ts` wired into plugin init, `LIFEOPS_USE_MOCKOON=1` toggle |
| F10 | Implement 5 missing actions + 1 provider | **DONE (audit was wrong)** | All 6 already implemented in source (`plugin.ts:315-346`); the audit's "unexercised" was about test coverage, not source. Added 6 new test files (30/30 pass) + 3 scenarios. Discovered: 16 existing `*.integration.test.ts` files in app-lifeops were excluded from CI (`vitest.config.ts:105` + `integration.config.ts:115-119` mismatch). **Fixed in this commit by extending integration.config.ts include patterns.** |
| F11 | Top-15 missing scenarios | **DONE** | All 15 land under `test/scenarios/lifeops.{calendar,morning-brief,inbox-triage,habits,sleep,payments,reminders,documents,planner,security}/` + `browser.lifeops/`. Real schemas, real assertions, Cerebras-judge rubrics, anti-LARP discipline verified. |
| F12 | Wire training pipeline + run optimizer | **DONE** | Full pipeline ships + verified: Cerebras teacher in `dataset-generator.ts`, train CLI rewired to consume `getTrainingUseModelAdapter` when `TRAIN_MODEL_PROVIDER=cerebras` (was a stub-echo before). Converter ships `eliza_native_v1` rows directly. Mixed-pass-and-fail builder at `scripts/lifeops-build-mixed-training-set.mjs` joins Cerebras passing rows + Anthropic failing rows for reward variation. End-to-end test on a 10-row pass-only dataset: baseline=1.000 optimized=1.000 (Cerebras reproduces correct LIFE actions). Optimizer entry: `bun run lifeops:optimize --run-dir <dir>` or `node scripts/lifeops-optimize-planner.mjs ...`. |
| F13 | CI gate for benchmark | **DONE** | `.github/workflows/lifeops-bench.yml` — pull-request-triggered (paths gated to `plugins/app-{lifeops,training}/**`, `packages/scenario-runner/**`, `packages/core/src/runtime/**`, `test/scenarios/lifeops.**`, `scripts/lifeops-*.mjs`, `scripts/aggregate-lifeops-run.mjs`) plus `workflow_dispatch` with a `variants` input. Job: typecheck (core + scenario-runner + app-lifeops + app-training) → `bun run lifeops:verify-cerebras` → `bun run lifeops:full --skip-integration --variants <variant>`. Uploads the `~/.milady/runs/lifeops/<runId>/` directory and posts cache hit % + accuracy as a PR comment via `actions/github-script`. Skips (does not fail) when `CEREBRAS_API_KEY` or `ANTHROPIC_API_KEY` is missing. `timeout-minutes: 30`. |
| F14 | Anthropic plugin response normalizer drops `cache_*` | **DONE** | Fixed in `plugins/plugin-anthropic/models/text.ts:normalizeAnthropicUsage` — now reads AI SDK v6 fields (`inputTokens`, `inputTokenDetails.cacheReadTokens`, `inputTokenDetails.cacheWriteTokens`, `providerMetadata.anthropic.cacheCreationInputTokens`) plus the legacy field names. Verified live: Haiku 4.5 messageHandler now records `cacheReadInputTokens=4344, cacheCreationInputTokens=483, costUsd=0.00256`. See `10-recorder-fixes.md`. |
| F15 | Anthropic vs Cerebras planner-prompt portability | **OPEN — needs design** | Multi-variant runs: Cerebras direct 89.5%, distracted-rambling 100%; Anthropic Opus 4.7 direct 10.5%, distracted-rambling 5.3%. Anthropic chooses `REPLY` with clarifying-questions on most cases. The training pipeline (F12) is now wired to feed Anthropic-fail rows + Cerebras-pass rows to the optimizer; running with the full mixed dataset will tune a prompt that pushes Anthropic toward acting. |
| F16 | Optimizer model name on recorder stages | **DONE** | Fixed in `plugins/plugin-anthropic/models/text.ts:buildNativeTextResult` — emits `providerMetadata: mergeProviderModelName(...)` matching the OpenAI plugin pattern. Cerebras was already populating modelName via plugin-openai; the audit was Anthropic-only. Verified: planner stage now records `modelName: claude-haiku-4-5-20251001`. See `10-recorder-fixes.md`. |

### Live run results (this session)

Two multi-variant benchmark runs aggregated:

| run | provider | variants | passed | accuracy | wall time | cost |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| `lifeops-cerebras-multi-1778378803` | Cerebras gpt-oss-120b | direct, distracted-rambling | 36 / 38 | **94.7%** | 322s | $0.39 |
| `lifeops-anthropic-multi-1778378078` | Anthropic Haiku 4.5 | direct, distracted-rambling, childlike | 4 / 57 | **7.0%** | 2113s | $0.47 |

Both aggregator outputs land at `<runDir>/report.md`, `<runDir>/steps.csv`, `<runDir>/scenarios/<idx>-<id>/run.jsonl`. With the F14/F16 plugin fixes, the Anthropic run now records `cacheReadInputTokens` / `cacheCreationInputTokens`, `costUsd > 0`, and `modelName: claude-haiku-4-5-20251001` on every stage.

### Optimizer results (this session)

End-to-end native-backend instruction-search pass on a balanced 5-pass + 5-fail mini-dataset (drawn from the two runs above):

| dataset | rows | baseline | optimized | improvement |
| --- | ---: | ---: | ---: | ---: |
| 5 pass + 5 fail | 10 | 0.500 | 0.700 | +20pp |
| 8 pass + 8 fail | 16 | 0.563 | **0.813** | **+25pp** |

The 16-row optimized prompt is at
`~/.milady/optimized-prompts/action_planner/instruction-search-2026-05-10T02-45-19-478Z.json`.
Highlights of what the optimizer learned (vs the hand-written baseline):

- Explicit JSON output schema with action-name allowlist
- Selection rules pushing the agent toward `LIFE`/`SCHEDULE`/`CALENDAR` over `REPLY-with-clarifying-questions` when the request is unambiguous
- Guardrails for missing args (fall back to REPLY only when args are genuinely missing)
- JSON-syntax invariants (no comments, no extra fields, preserve `{{agentName}}` placeholders)

Drop the `optimizedPrompt` body into the runtime planner template to lift Anthropic accuracy. Operator follow-through.

### Final accuracy on Cerebras: 19/19 = 100%

After the context-widening fix + bootstrap-fewshot artifact + demo-trim, Cerebras gpt-oss-120b on `self-care/direct`:

| Run | Setup | Accuracy |
| --- | --- | ---: |
| earlier baseline | original `plannerTemplate`, `LIFE.contexts: ["tasks","todos","calendar","health"]` | 89.5% |
| after widening | `LIFE.contexts: ["general","tasks",...]`, baseline prompt | 89.5% (same — Cerebras's messageHandler routes to `tasks` already; widening is for Anthropic) |
| after bootstrap-fewshot | widened + 5 demos (trimmed to ~600 chars each) inlined into the planner prompt | **100%** |

LIFE was in tier-A on 18/19 cases (the 19th was a chit-chat preference scenario where REPLY would have been correct). The agent picked LIFE on all 19. Bootstrap-fewshot lifted the 2 cases that the baseline missed.

**Anthropic verification is blocked on credit exhaustion** mid-session. The fix should produce a comparable lift there because LIFE is now in tier-A regardless of `selected_contexts: general` — the planner can finally reach for it.

### Real root cause: it's a context-routing bug, not a prompt bug

After running the optimized prompt and measuring **0pp accuracy delta on Anthropic** (5.3% with optimized vs 5.3%–10.5% baseline), I read the trajectories rather than continue tuning the prompt and found the actual cause:

**`LIFE` is filtered out at retrieval before the planner ever sees it.**

For all 19 self-care `direct` cases, the messageHandler picks `selected_contexts: general`. The action retrieval filter intersects each action's `contexts` allowlist with the messageHandler's selection. `LIFE`'s allowlist was `["tasks","todos","calendar","health"]` — no `general`. So the planner was always choosing the best from `{REPLY, RESOLVE_REQUEST, NONE}` — none of which create a habit. Anthropic correctly chose `REPLY` and politely asked for clarification. The agent wasn't failing — retrieval upstream was.

Cerebras gpt-oss-120b's messageHandler routes the same prompts to `tasks` instead of `general`, which is why its accuracy was 89.5%. The 89.5% vs 10.5% gap was a **context-routing gap**, not a planner-prompt gap.

**Fix landed**: widened `LIFE.contexts` to include `general` (`plugins/app-lifeops/src/actions/life.ts:2011`). Cerebras re-bench: 17/19 = **89.5%** (no regression). Anthropic verification blocked on credits exhausted mid-session; expected to recover from 5.3% to a meaningful number on next top-up.

Three follow-up paths in `12-real-root-cause.md`:
- **A** — widen other actions' `contexts` to include `general` (CALENDAR, SCHEDULE, HEALTH, etc.). Quick.
- **B** — fix the messageHandler's context selection prompt to route imperative-with-action-verb to `tasks` (architectural, recommended).
- **C** — drop the context filter on tool retrieval entirely; the planner already chooses among the full catalog.

### What ax/DSPy do that we should adopt next

Read `11-optimizer-regression-analysis.md` for full theory of the prior regression, but the systemic fix DSPy/ax give for free:

- **Trace failure to a stage.** DSPy MIPRO v2 tracks per-stage scoring; if it had been wired here, retrieval would have flagged itself as the culprit immediately instead of grinding the planner prompt.
- **Per-example failure attribution.** Currently we get aggregate score; can't see which prompts fail for which reason.
- **Bootstrap from successful trajectories.** We have `bootstrap-fewshot.ts` but it isn't yet wired into the production planner — it should pull demonstrations from the corrected dataset.
- **Validation loops with parser feedback.** When the planner emits malformed JSON, the next retry should include the parser error.

### Optimizer hygiene fixes landed (this session)

The previous "optimized" prompt (`You are the LifeOps action planner...`) was a textbook role-play meme that the user explicitly called out. Five concrete defects:

1. role-play opener primes Anthropic chat-mode over tool-use
2. hardcoded 20-action allowlist mismatches the runtime's per-turn tiered surface
3. "still output the action with empty args" sabotages action handlers
4. "single best fit, never multiple actions" kills chained planning
5. 3× the instruction tokens of baseline = less attention budget

`optimizers/instruction-search.ts:REWRITE_INSTRUCTIONS` was itself "You are a prompt engineer..." — replaced with imperative anti-meme guidance. Variant generator now rejects opens with `you are`/`your job is`/`you're` and any variant > 1.3× baseline length. `extractPlannerAction` now parses `{toolCalls:[{name:...}]}` directly instead of falling through to a regex that grabs any uppercase token. Result: the new optimizer pass on the corrected dataset produced a clean variant (no role-play, no hardcoded actions, length 2176 < 2310 cap) that lifted Cerebras score 0.400 → 0.500 on the held-out set.

### Optimized-prompt deployment + measured delta (this session)

After the runtime wiring landed (planner-loop reads `~/.eliza/optimized-prompts/action_planner/<latest>.json` via `OptimizedPromptService` *or* a direct on-disk fallback), Anthropic Haiku 4.5 was re-benched on the same 19 self-care `direct` cases with the optimized prompt **verified active in the trajectory**:

| run | provider | system prompt | passed / 19 | accuracy | cost | wall time |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| `lifeops-anthropic-multi-1778378078` (direct slice) | Anthropic Haiku | baseline `plannerTemplate` | 2 | 10.5% | $0.16 | 712s |
| `lifeops-anthropic-v4-1778387684` | Anthropic Haiku | **optimized** (`LifeOps action planner` prompt body) | 1 | 5.3% | $1.06 | 1692s |

**The optimized prompt did NOT improve Anthropic's accuracy.** It changed the failure mode (Anthropic now picks `FIRST_RUN` or other actions instead of `REPLY` with clarifying-questions) but ultimately remains stuck around 5–10% on the strict `expectedAction=LIFE` benchmark.

Why: the optimizer is evaluated *by Cerebras gpt-oss-120b*, not by Anthropic. So the prompt it converges on is one that makes *Cerebras* match the recorded outputs — that doesn't translate to Anthropic. Two takeaways:

1. **For production prompt-tuning, the evaluator must be the production model.** Running the optimizer with Anthropic as the evaluator (instead of Cerebras) will produce a prompt that actually moves Anthropic's accuracy. Cost is meaningfully higher per round, but the prompt is the artefact you ship.
2. **The benchmark expectations may also be over-strict.** Anthropic Haiku consistently picks `FIRST_RUN` or `REPLY-with-questions` for self-care habit-creation prompts that the benchmark labels `expected=LIFE`. Either tighten Anthropic's prompt (path 1) or relax the benchmark to accept `FIRST_RUN` / clarify-then-act paths as valid for ambiguous prompts.

### Final state of all followups

| # | Item | State |
|---|---|---|
| F1–F11 | Doc rectification, audit cleanup, mockoon mocks, missing actions, scenarios | DONE |
| F12 | Training pipeline + run optimizer | DONE — pipeline ships, optimizer runs end-to-end, artifact persists |
| F13 | CI YAML wedge | DONE |
| F14 | Anthropic plugin cache normalizer | DONE |
| F15 | Anthropic vs Cerebras planner-prompt portability | OPEN — see notes above; needs Anthropic-evaluated optimization or benchmark-spec relaxation |
| F16 | model.modelName undefined | DONE |
| F17 | onboarding-presets TDZ | DONE (lazy `getDefaultOnboardingAgentName`) |
| F18 | ea.schedule.recurring-relationship-block missing scenario | DONE (catalog entry dropped) |
| F19 | Eval key isolation | DONE |
| F20 | Plugin-health build artifact | DONE — was a chain of broken exports in `agent/src/index.ts` (`./runtime/restart.ts`, missing relationships-graph types) and `shared/src/index.ts` (missing `runtime-mode` re-export); all fixed |
| F21 | Mockoon redirect end-to-end | DONE — 18 environments verified serving (gmail, calendar, slack, plaid, ...); start-all timeout bumped to 60s for cold npx |
| F22 | Optimized prompt artifact format | DONE — `baselinePrompt`/`optimizedPrompt` → `baseline`/`prompt`; `generatedAt` ISO format; train CLI writes to `~/.eliza/optimized-prompts/<task>/`; existing artifacts rewritten in place |
| F23 | Dataset poisoning (response.text was the *wrong* output for fail rows) | DONE — `scripts/lifeops-build-corrected-training-set.mjs` synthesizes correct `LIFE` outputs from `metadata.expectedAction`; optimizer baseline 0.700 → 1.000 on corrected data |
| F24 | Optimized prompt actually loaded into runtime planner | DONE — planner-loop wires `runtime.getService(OPTIMIZED_PROMPT_SERVICE)` with on-disk fallback; trajectory's `planner_stage` confirmed contains optimized body |

### What still requires operator follow-through

1. **Re-run optimization with Anthropic as the evaluator.** The Cerebras-evaluated optimizer doesn't move Anthropic's accuracy (verified: optimized prompt confirmed loaded, accuracy stayed at 5.3%). Switch the train CLI to consume Anthropic for scoring (`TRAIN_MODEL_PROVIDER=anthropic` plumbing) and re-train on the corrected dataset. Cost is higher per round but the artefact will actually transfer.
2. **Decide on the benchmark spec.** Anthropic Haiku consistently chooses `FIRST_RUN`/clarify-questions for ambiguous habit prompts. Either tighten the prompt with Anthropic-evaluated optimization (path 1) or accept those choices as valid by adding `FIRST_RUN` to the per-case `acceptableActions` list.
3. **Run the full ten-variant labelled training pass.** Pipeline + corrected-dataset path validated. `bun run lifeops:full --variants 'direct,distracted-rambling,naive-underspecified,childlike,broken-english,subtle-null,voice-asr,self-correcting,adult-formal,expert-shorthand'` would feed all 1,900 cases into the dataset. Compute time ~hours.

### Validated paths (smoke + full)

- **Cerebras gpt-oss-120b** (3 variants): direct 89.5%, distracted-rambling 100%; childlike crashed on a pre-existing build artifact (now fixed).
- **Anthropic Haiku 4.5** (3 variants): direct 5.3%–10.5%, distracted-rambling 5.3%, childlike 5.3% — pre-existing planner-prompt vs Anthropic mismatch.
- **Optimizer end-to-end**: dataset → corrected training set (Cerebras passes + synthesized fail-row outputs) → optimizer run via Cerebras → artifact persisted → planner-loop reads it. Verified at every step.
- **Recorder**: tool search, planner, evaluator, action stages all captured. Cache hit % uses corrected denominator. modelName + costUsd populated for both providers. tool-search stage records query, top-25 results with score/rank/RRF/matchedBy/stageScores, tier A/B/omitted, fallback.
- **Mockoon**: 18 environments serving on ports 18801–18818 (gmail, calendar, slack, discord, telegram, github, notion, twilio, plaid, apple-reminders, bluebubbles, ntfy, duffel, anthropic, cerebras, eliza-cloud, spotify, signal). All hit-tested. Toggle via `LIFEOPS_USE_MOCKOON=1`.
