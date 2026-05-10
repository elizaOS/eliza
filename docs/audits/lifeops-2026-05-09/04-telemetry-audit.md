# LifeOps telemetry audit — 2026-05-09

Working tree: `/Users/shawwalters/milaidy/eliza/`. All file:line citations are absolute under that root.

## TL;DR

- A rich per-stage trajectory recorder already exists for the planner loop, evaluator, sub-planner, message-handler, and tool execution. It writes one JSON file per turn under `~/.milady/trajectories/<agentId>/<trajectoryId>.json` and persists `cache_creation_input_tokens` / `cache_read_input_tokens` per LLM stage.
- Tool-search (action retrieval / tiering) is **not** recorded anywhere. It runs once per planner turn inside `buildV5PlannerActionSurface` and the result is dropped on the floor.
- The lifeops scenarios, e2e harness, and benchmark runner do **not** read that recorder. The `ScenarioReport` shape only carries `actionsCalled` and `durationMs` — no per-step tokens, no per-step cache hit %, no provider/model identifiers.
- Per-step `prev_step_cache_pct` requires either (a) computing it inside the recorder when emitting the next stage, or (b) post-processing the JSON trajectory in an aggregator that writes the JSONL the user wants.
- There is no single per-run results dir today. The best plumbing seam is:
  1. Have the scenario CLI set `MILADY_TRAJECTORY_DIR=<runDir>/trajectories/` for the runtime.
  2. Add a tool-search recorder hook (the only missing phase).
  3. Add a small aggregator that streams stages to a per-scenario JSONL and writes `report.md` + `steps.csv`.

---

## A. Existing telemetry — what's already wired

### A.1 Core recorder infrastructure

| Component | File:line | Purpose |
|---|---|---|
| `TrajectoryRecorder` interface | `packages/core/src/runtime/trajectory-recorder.ts:178-187` | `startTrajectory`, `recordStage`, `endTrajectory`, `load`, `list` |
| `RecordedStageKind` enum | `packages/core/src/runtime/trajectory-recorder.ts:33-40` | `messageHandler` \| `planner` \| `tool` \| `evaluation` \| `subPlanner` \| `compaction` \| `factsAndRelationships` (note: **no** `toolSearch`) |
| `RecordedUsage` shape | `packages/core/src/runtime/trajectory-recorder.ts:42-48` | `promptTokens`, `completionTokens`, `cacheReadInputTokens?`, `cacheCreationInputTokens?`, `totalTokens` |
| `RecordedStage` shape | `packages/core/src/runtime/trajectory-recorder.ts:121-134` | model, tool, evaluation, cache, factsAndRelationships sub-blocks |
| `RecordedTrajectoryMetrics` aggregates | `packages/core/src/runtime/trajectory-recorder.ts:136-148` | totals incl. `totalCacheReadTokens`, `totalCacheCreationTokens`, `totalCostUsd` |
| `JsonFileTrajectoryRecorder` impl | `packages/core/src/runtime/trajectory-recorder.ts:680-893` | atomic JSON write per stage |
| `resolveTrajectoryDir` precedence | `packages/core/src/runtime/trajectory-recorder.ts:221-232` | `MILADY_TRAJECTORY_DIR` → `MILADY_STATE_DIR/trajectories` → `ELIZA_STATE_DIR/trajectories` → `~/.milady/trajectories` |
| Toggle | `packages/core/src/runtime/trajectory-recorder.ts:237-239` | `MILADY_TRAJECTORY_RECORDING=0` to disable; default on |

### A.2 Where stages are recorded today

| Phase | Recorded? | File:line | Captures cache tokens? |
|---|---|---|---|
| Message-handler (Stage 1) | yes | `packages/core/src/services/message.ts:4369-4422` (`recordMessageHandlerStage`) | yes — `extractMessageHandlerUsage` at `4585-4619` |
| Planner LLM call | yes | `packages/core/src/runtime/planner-loop.ts:1222-1289` (`recordPlannerStage`); calls `extractUsage` at `1291-1322` | yes — pulls `cacheReadInputTokens` & `cacheCreationInputTokens` from `raw.usage` and from legacy `cachedPromptTokens` |
| Compaction iteration | yes | `packages/core/src/runtime/planner-loop.ts:1172-1220` (`recordCompactionStage`) | n/a — no LLM call recorded |
| Gated evaluation (no LLM) | yes | `packages/core/src/runtime/planner-loop.ts:1132-1170` (`recordGatedEvaluationStage`) | n/a |
| Evaluator LLM call | yes | `packages/core/src/runtime/evaluator.ts:140-207` (record body); `extractEvaluatorUsage` at `223-255` | yes |
| Tool / action execution | yes | `packages/core/src/runtime/planner-loop.ts:1622-1656` (`recordToolStage`); call at `1610-1619` | n/a — tool stages don't model LLM usage |
| Sub-planner | yes | `packages/core/src/runtime/sub-planner.ts:313-351` | no model usage attached |
| Facts/relationships | yes | `packages/core/src/services/message.ts:4424-4480` (`recordFactsAndRelationshipsStage`) | not currently — `model.usage` is omitted; stage records `result.rawResponse` only |
| **Tool search / action-retrieval / tiering** | **NO** | `packages/core/src/services/message.ts:1641-1716` — `retrieveActions` (`runtime/action-retrieval.ts:53-179`) and `tierActionResults` are called inline in `buildV5PlannerActionSurface`; the `ActionRetrievalResponse` (with `query`, `results[].score`, `stageScores`, `matchedBy`, `rrfScore`, `rank`) is **never persisted** | n/a — pure CPU step |
| Loop iteration boundary | implied via `iteration` field on planner/evaluator/tool stages | each stage carries `iteration?: number` (e.g. `planner-loop.ts:1252` uses `args.iteration`) | n/a |

### A.3 Recorder lifecycle

- `startTrajectory` is called once per turn at `packages/core/src/services/message.ts:3882-3894`.
- `endTrajectory` is called at `packages/core/src/services/message.ts:4358-4361`.
- The same recorder instance is created per turn via `createJsonFileTrajectoryRecorder({...})` at `message.ts:3876`.
- An optional Markdown sibling can be emitted via `MILADY_TRAJECTORY_REVIEW_MODE` / `MILADY_TRAJECTORY_MARKDOWN`. (`trajectory-recorder.ts:245-256`).

### A.4 Anthropic/OpenAI usage normalization

- `cacheCreationInputTokens` and `cacheReadInputTokens` are surfaced from the Anthropic plugin: `plugins/plugin-anthropic/models/text.ts:492-513` (`normalizeAnthropicUsage`).
- Two parallel normalizers exist in core: `packages/core/src/runtime/cache-observation.ts:63-145` and `packages/core/src/runtime/cache-observer.ts:45-114`. **These are duplicates that both export `normalizeCacheUsage`** — flag for the Deduplication agent. Neither is called from the trajectory recorder hooks; the planner/evaluator/messageHandler `extract*Usage` helpers each have their own inline reader. That duplication is the cause of subtle drift (e.g. `cache-observer.ts` doesn't fall back to `cachedPromptTokens` for OpenAI; `cache-observation.ts` does).
- The `MODEL_USED` event payload (`packages/core/src/types/events.ts:214-221`) carries only `tokens.{prompt,completion,total}` — no cache fields, and in practice the event is **not emitted** anywhere (grep finds zero `EventType.MODEL_USED` emit sites). Don't subscribe to events for cache stats; read the recorder.

### A.5 Agent-level (DB-backed) trajectory pipeline

The runtime separately writes a flat per-step LLM-call record into the agent's database via `recordUseModelTrajectory` at `packages/core/src/runtime.ts:4467-4561`. That path *also* captures `cacheReadInputTokens` and `cacheCreationInputTokens` (`runtime.ts:4548-4551`) and persists them via `appendLlmCall` at `packages/agent/src/runtime/trajectory-storage.ts:86-180` (cache fields at `:140-151`).

The DB schema is exposed via `/api/trajectories/<id>` and `/api/trajectories?...` and is what `lifeops-prompt-benchmark-runner.ts:208-270` already polls (`captureTrajectoryForCase`). However the DB schema lacks the per-stage `kind` taxonomy — every LLM call is `stepKind: "llm" | "action"` only (`packages/core/src/services/trajectory-types.ts:126`). For per-phase reporting we need the JSON-file recorder, not the DB.

### A.6 Lifeops harnesses

- `plugins/app-lifeops/test/helpers/lifeops-live-harness.ts` — boots a child runtime, polls `/api/trajectories` (`:741-746`, `:911-1031`). Does **not** scrape per-stage cache stats; only checks that the trajectory contains an `llmCall` matching the user prompt.
- `plugins/app-lifeops/test/helpers/lifeops-prompt-benchmark-runner.ts` — calls `flushTrajectoryWrites`, then reads via the runtime's `trajectories` service (`:208-270`). The `PromptBenchmarkResult` (`:26-38`) records `latencyMs`, `llmCallCount`, `plannerPrompt`, `plannerResponse` but **not** any token counts, **not** cache stats, **not** per-stage data.
- `packages/scenario-runner/src/types.ts:33-59` — `TurnReport` and `ScenarioReport` carry `actionsCalled`, `durationMs`, `failedAssertions` only. No tokens, no cache, no provider/model.
- `packages/scenario-runner/src/reporter.ts:48-81` — `writeReport` and `writeReportBundle` write JSON of the above shape.

### A.7 Existing aggregator that already understands the JSON trajectories

`scripts/analyze-trajectories.mjs:1-166` walks the JSON trajectory tree, counts `cacheReadInputTokens`/`cacheCreationInputTokens` per model call, computes a global cache hit % (`totalCacheRead / totalPrompt`), totals cost. Useful as a template/reference for the new aggregator but it does **not** emit per-step JSONL or per-scenario CSV.

`scripts/cache-hit-rate-harness.mjs` is a stand-alone provider probe (raw OpenAI-compatible POSTs); not used by scenarios.

---

## B. Per-signal coverage matrix

| Signal | Captured? | Storage | File:line |
|---|---|---|---|
| 1. Tool-search input prompt | NO | — | needs new hook around `services/message.ts:1666-1675` |
| 1. Tool-search candidate tools / scores | NO | — | `runtime/action-retrieval.ts:139-150` produces `ActionRetrievalResult[]`; never persisted |
| 1. Tool-search chosen tool(s) | partial | the `tieredSurface.exposedActionNames` ends up in the planner stage's `model.tools` list, but the *retrieval scoring* is lost | `services/message.ts:1676-1679` |
| 2. Planner prompt | yes | recorder JSON `stages[].model.messages` | `runtime/planner-loop.ts:1263` |
| 2. Planner model + provider | yes | `stages[].model.modelName`, `model.provider` | `runtime/planner-loop.ts:1261-1262`, `:1331-1343` |
| 2. Planner response text | yes | `stages[].model.response` | `runtime/planner-loop.ts:1267` |
| 2. Planner parsed plan (tool calls) | yes | `stages[].model.toolCalls[]` | `runtime/planner-loop.ts:1268-1273` |
| 2. Planner retries | partial | each retry produces a separate planner stage with a unique `stageId`; no explicit `retry_idx` field | `runtime/planner-loop.ts:1252` |
| 3. Action name + params | yes | `stages[].tool.{name,args}` | `runtime/planner-loop.ts:1641-1647` |
| 3. Action result + success | yes | `stages[].tool.{result,success}` | `runtime/planner-loop.ts:1644-1645` |
| 3. Action duration | yes | `stages[].tool.durationMs`, `stages[].latencyMs` | `runtime/planner-loop.ts:1640-1646` |
| 3. Action error | partial | rolls into `tool.result` shape; no first-class `error` field on tool stage | needs flag |
| 4. Evaluator name | partial | implicit (always single evaluator); not labelled | — |
| 4. Evaluator verdict / decision | yes | `stages[].evaluation.decision` (`FINISH` \| `CONTINUE`) | `runtime/evaluator.ts:186-194` |
| 4. Evaluator confidence | NO | not modelled in `RecordedEvaluationStage` | `core/src/runtime/trajectory-recorder.ts:80-82` |
| 4. Evaluator raw output | yes | `stages[].model.response` (when LLM call) or `evaluation.thought` for gated | `runtime/evaluator.ts:158-185` |
| 5. Loop iteration counter | yes | `stages[].iteration` on planner/evaluator/tool/compaction | `planner-loop.ts:1148, 1190, 1254` |
| 6. `cache_creation_input_tokens` | yes (planner/eval/msgHandler) | `stages[].model.usage.cacheCreationInputTokens` | `planner-loop.ts:1317-1320`, `evaluator.ts:223-255`, `services/message.ts:4615-4617` |
| 7. `cache_read_input_tokens` | yes | same fields, `cacheReadInputTokens` | `planner-loop.ts:1305-1316`, `services/message.ts:4606-4614` |
| 8. `input_tokens` (uncached portion) | indirectly | Anthropic/OpenAI return `inputTokens` (or `promptTokens`) which **already excludes** cached reads on Anthropic; cached reads are billed separately as `cacheReadInputTokens`. Cross-check with Anthropic docs: their `usage.input_tokens` excludes `cache_read_input_tokens` and `cache_creation_input_tokens`. | `plugin-anthropic/models/text.ts:499-505` confirms `promptTokens = usage.promptTokens ?? usage.inputTokens` |
| 9. `output_tokens` | yes | `usage.completionTokens` (alias `outputTokens`) | `cache-observation.ts:119-124`, `planner-loop.ts:1297-1304` |
| 10. Wall-clock duration | yes | `stages[].latencyMs`, `startedAt`, `endedAt` | `trajectory-recorder.ts:127-128` |
| 11. Provider + model identifier | yes | `stages[].model.{provider, modelName}`; cost via `cost-table.ts` | `planner-loop.ts:1262, 1275`, `evaluator.ts:177` |

Summary: **1/11 signals (tool search) is missing**. Everything else lands in the JSON trajectory recorder. Evaluator confidence is not currently modelled but an evaluator that emits a confidence field can have it added by extending `RecordedEvaluationStage`.

---

## C. Cache hit % formula

### C.1 Anthropic semantics

Anthropic's `messages` API returns four token fields on `usage`:
- `input_tokens` — prompt tokens **billed at full rate** (the uncached portion).
- `cache_creation_input_tokens` — prompt tokens **billed at write rate** (added to cache this call).
- `cache_read_input_tokens` — prompt tokens **billed at read rate** (served from cache).
- `output_tokens` — completion tokens.

Total prompt tokens this step = `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`. (Anthropic excludes the cached portions from `input_tokens`.)

### C.2 What "cache hit % from the previous step" means here

Two reasonable definitions; pick (b) for the per-step report:

**(a) per-step internal hit rate**
```
this_step_hit_pct = cache_read / (input + cache_creation + cache_read)
```
This is what the existing `cacheHitRate` helper at `core/src/runtime/cache-observation.ts:147-159` computes — but it uses `cachedInputTokens / inputTokens`, which is **wrong by the Anthropic semantics** (denominator should include cached). The OpenAI plugin's `cachedPromptTokens` is *included* in `promptTokens`, so the existing formula happens to be right for OpenAI but wrong for Anthropic. The user wants the cache hit % per Anthropic, so we use the corrected denominator.

**(b) "cache hit from previous step" — what the user asked for**
At step *n*, of the prompt that was sent, how much was a hit on the cache produced by step *n-1*?
```
prev_step_cache_pct[n] = cache_read[n] / (input[n] + cache_creation[n] + cache_read[n])
```
This is identical to (a) numerically because `cache_read_input_tokens` *is* a hit on a previously written entry — the prefix that step *n-1* wrote (or earlier). The "previous step" framing is mostly a labelling convention; the math is the per-call hit rate.

If the recorder needs an explicit "hit on what step *n-1* wrote" we can also compute:
```
new_writes[n-1] = cache_creation_input_tokens[n-1]
hit_on_prev[n] = min(cache_read_input_tokens[n], total_writes_so_far_up_to_n-1)
```
This requires running totals. Recommend computing the simple per-call ratio (b) as `prev_step_cache_pct` and surface running cache totals in the run-level summary.

### C.3 Where the math lives now

- `core/src/runtime/cache-observation.ts:147-159` — `cacheHitRate(...)` returns `cachedInputTokens / inputTokens` (denominator excludes cached on Anthropic — semantically wrong for Anthropic).
- `core/src/runtime/cache-observation.ts:194-197` — `summarizeCacheUsage` uses the same wrong denominator.
- `app-core/test/helpers/trajectory-harness.ts:333-346` — formats `cache read N (P%)` using `cacheReadInputTokens / promptTokens` — same mistake.
- `scripts/analyze-trajectories.mjs:79-80` — accumulates totals and at the end computes a global rate; recommend re-using its denominator pattern but include `cacheCreate`.

The new recorder/aggregator should compute `total_input = (input ?? prompt) + cache_creation + cache_read` and then `cache_hit_pct = cache_read / total_input`. This matches the user's spec.

---

## D. New recorder hook points (file:line)

The recorder already exists. Five concrete hook gaps:

### D.1 Tool-search entry/exit (the only missing phase)

- **Hook point:** wrap the call inside `buildV5PlannerActionSurface` in `packages/core/src/services/message.ts:1641-1716`.
- Specifically: capture before-and-after `retrieveActions(...)` at `:1666-1675` plus `tierActionResults(...)` at `:1676-1679`.
- Required schema additions:
  - Add `"toolSearch"` to `RecordedStageKind` at `packages/core/src/runtime/trajectory-recorder.ts:33-40`.
  - Add `toolSearch?: RecordedToolSearchStage` to `RecordedStage` at `:121-134` with shape:
    ```
    interface RecordedToolSearchStage {
      query: { text: string; tokens: string[]; candidateActions: string[]; parentActionHints: string[] };
      results: Array<{ name: string; score: number; rank: number; rrfScore: number; matchedBy: RetrievalStageName[]; stageScores: Partial<Record<RetrievalStageName, number>> }>;
      tier: { tierA: string[]; tierB: string[]; omitted: number };
      durationMs: number;
      fallback?: string;
    }
    ```
- The `recordToolSearchStage(...)` helper should sit alongside `recordMessageHandlerStage` in `services/message.ts` (the recorder is already in scope at `:3876`).

### D.2 Planner LLM call entry/exit

- **Already hooked.** Entry+exit happens in one shot via `recordPlannerStage` at `packages/core/src/runtime/planner-loop.ts:1222-1289`.
- Add explicit `retry_idx` to differentiate retried planner calls. Today retries produce duplicate stages with the same `iteration` and slightly different `startedAt`; downstream cannot distinguish a retry from a follow-on iteration without inferring.
- Recommend: add `retryIdx?: number` to `RecordedStage` and pass it from the retry loop (need to find the retry caller in `planner-loop.ts` — search for `runPlannerOnce` or similar).

### D.3 Action handler entry/exit

- **Already hooked** at `packages/core/src/runtime/planner-loop.ts:1610-1656` (`recordToolStage`).
- The entry side is the call site in `runPlannedToolCall`-equivalent at `:1610`. Action errors currently end up inside `result` — add a top-level `error?: string` to `RecordedToolStage` (`trajectory-recorder.ts:72-78`) so consumers don't need to dig.
- The actual handler call is at `packages/core/src/runtime/execute-planned-tool-call.ts:215-228`, but recording at the planner-loop layer is correct because that's where we know the iteration index.

### D.4 Evaluator entry/exit

- **Already hooked** at `packages/core/src/runtime/evaluator.ts:140-207` (the function body of the recording helper; see also `:185` where `parseError` is recorded).
- Gated path also recorded at `packages/core/src/runtime/planner-loop.ts:1132-1170`.
- Add evaluator `name` field if/when multiple evaluators are wired (today there is one).

### D.5 Loop iteration boundary

- The "iteration" is implicit on each stage (`stage.iteration`), and the runner already increments it in the planner loop (`packages/core/src/runtime/planner-loop.ts` — search for `iteration` increments around the loop). To get an explicit "iteration boundary" event, emit a synthetic stage of kind `loopIteration` at the top of each iteration. Optional; if the aggregator groups by `iteration`, no new stage is needed.

---

## E. Single-results-dir plumbing

### E.1 Existing plumbing seam

- The trajectory recorder honours `MILADY_TRAJECTORY_DIR` (highest-precedence env var, see `core/src/runtime/trajectory-recorder.ts:222-224`).
- The scenario CLI accepts `--report-dir` and writes the `AggregateReport` plus per-scenario JSON: `packages/scenario-runner/src/cli.ts:65-225`.
- The lifeops live harness writes nothing structured; it tails logs and polls `/api/trajectories`.

### E.2 Proposed per-run layout

```
~/.milady/runs/lifeops/<run-id>/
  trajectories/                          # raw recorder JSON, one per turn
    <agentId>/<trajectoryId>.json
  scenarios/
    001-brush-teeth-basic/
      run.jsonl                          # per-step lines, schema below
      meta.json                          # scenario id, started/ended, provider, model
    002-...
  matrix.json                            # existing AggregateReport
  report.md                              # human-friendly summary
  steps.csv                              # flat steps spreadsheet
```

`<run-id>` is the existing `runId` already produced by `packages/scenario-runner/src/cli.ts:108` and surfaced on `AggregateReport.runId`.

### E.3 JSONL schema (per step)

Drop one line per recorded stage. The user-requested fields plus the ones the recorder gives us for free:

```json
{
  "run_id": "...",
  "scenario": "brush-teeth-basic",
  "trajectory_id": "tj-...",
  "turn_idx": 0,
  "step_idx": 3,
  "iteration": 1,
  "phase": "planner",            // toolSearch | messageHandler | planner | tool | evaluation | subPlanner | compaction | factsAndRelationships
  "stage_id": "stage-planner-iter-1-...",
  "parent_stage_id": "stage-msghandler-...",
  "provider": "anthropic",
  "model": "claude-opus-4-7",
  "model_type": "TEXT_LARGE",
  "started_at": 1234,
  "ended_at": 1567,
  "duration_ms": 333,
  "input_tokens": 412,
  "output_tokens": 88,
  "cache_creation_input_tokens": 0,
  "cache_read_input_tokens": 11824,
  "total_input_tokens": 12236,
  "cache_hit_pct": 96.6,
  "prev_step_cache_pct": 96.6,    // = cache_read / (input + cache_creation + cache_read), per-call hit
  "retry_idx": 0,
  "tool_name": null,              // populated for phase=tool
  "tool_success": null,
  "evaluator_decision": null,     // populated for phase=evaluation
  "error": null,
  "cost_usd": 0.0123
}
```

For `phase=toolSearch`, populate a `tool_search` sub-object with `query`, `top_results[]`, `tier_a`, `tier_b`, `fallback` and skip the LLM/cache fields (they are zero for that phase).

### E.4 Aggregator: trajectory JSON → JSONL + report.md + steps.csv

Build on `scripts/analyze-trajectories.mjs:1-166` (already walks the JSON tree and reads `usage.cacheReadInputTokens`/`cacheCreationInputTokens`). Add:
- per-stage JSONL emission with the schema above.
- per-scenario `meta.json`.
- a `steps.csv` flattening (use Node's built-in `csv` formatting or just write CSV manually).
- a `report.md` rolling up by phase (avg duration, p50/p95, total tokens, cache hit %).

### E.5 Extend the existing trajectory writer or add a new pipe?

**Extend.** Reasons:
1. The JSON recorder already captures everything the user wants except tool-search.
2. The recorder already has the right precedence chain for output dir (`MILADY_TRAJECTORY_DIR`).
3. Stage schema is the right place to add `toolSearch`.
4. The aggregator is a standalone post-processor; we don't need a new live writer.

The only piece that needs a *new* writer is the per-scenario JSONL — and that's emitted from the aggregator post-run, not at runtime.

---

## F. Minimal patch plan

### F.1 Core recorder schema

**File:** `packages/core/src/runtime/trajectory-recorder.ts`
1. Line 33-40: extend `RecordedStageKind` with `"toolSearch"`.
2. Add (after line 109) interface `RecordedToolSearchStage` with `query`, `results`, `tier`, `durationMs`, `fallback?`.
3. Line 121-134: add `toolSearch?: RecordedToolSearchStage` to `RecordedStage`.
4. Line 72-78: add `error?: string` to `RecordedToolStage`.
5. Line 80-82: add optional `name?: string` (evaluator label) and `confidence?: number` to `RecordedEvaluationStage`.
6. Line 539-578: extend `applyMetricsForStage` so `kind === "toolSearch"` increments a new `toolSearchCount` total on `RecordedTrajectoryMetrics` (line 136-148: add `toolSearchCount: number`).
7. Line 398-537: extend `renderTrajectoryMarkdown` to render the toolSearch block.

### F.2 Tool-search hook

**File:** `packages/core/src/services/message.ts`
1. Line 23-24: keep imports.
2. Line 1641-1716 (`buildV5PlannerActionSurface`): wrap the `retrieveActions` + `tierActionResults` calls with `Date.now()` start/end timestamps; collect a structured `toolSearch` payload.
3. Pass `recorder` and `trajectoryId` into `buildV5PlannerActionSurface` (currently it doesn't receive them — caller around line 3950+ in the message-handler block has them in scope).
4. After `tierActionResults` returns, call a new `recordToolSearchStage(...)` defined alongside `recordMessageHandlerStage` at `:4369`.

### F.3 Retry index on planner stage

**File:** `packages/core/src/runtime/planner-loop.ts`
1. Find the planner retry call site (search for the loop that calls `runPlannerOnce` or whatever the planner LLM driver is named — around the `recordPlannerStage` call at line 1252).
2. Pass `retryIdx` down to `recordPlannerStage` and into `RecordedStage.retryIdx`.
3. Schema change in `trajectory-recorder.ts:121-134`: add `retryIdx?: number`.

### F.4 Cache-hit-rate formula correction

**File:** `packages/core/src/runtime/cache-observation.ts`
1. Line 147-159: change denominator from `inputTokens` to `inputTokens + cacheCreationInputTokens + cacheReadInputTokens` (or the `?? 0` chain).
2. Line 194-197: same fix for `summarizeCacheUsage`.
3. Mirror the fix into the duplicate `cache-observer.ts` — or, **preferred**, delete `cache-observer.ts` and re-export from `cache-observation.ts` (this is a Deduplication Agent task; the two are 90% identical).

**File:** `packages/app-core/test/helpers/trajectory-harness.ts:333-346` — same denominator fix.

### F.5 Aggregator script

**New file:** `scripts/aggregate-lifeops-run.mjs`
- Inputs: `--run-dir <runDir>` (defaults to `~/.milady/runs/lifeops/<latest>`), `--trajectory-dir <runDir>/trajectories` (defaults from env).
- For each `*.json` trajectory:
  - For each stage, emit one JSONL line per the schema in §E.3.
  - Group lines by `(scenario, trajectory_id)` and write to `<runDir>/scenarios/<idx>-<scenarioId>/run.jsonl`.
- Compute aggregates per scenario (totals, p50/p95 duration, cache hit %) → `report.md`.
- Compute flat row dump → `steps.csv`.

Reference implementation lives in `scripts/analyze-trajectories.mjs` (already reads cache fields at `:79-80`).

### F.6 Scenario runner: pass the run dir to the recorder

**File:** `packages/scenario-runner/src/cli.ts`
1. After parsing `--report-dir` (line 65-82), if `MILADY_TRAJECTORY_DIR` is unset, set it to `path.join(reportDir ?? defaultRunDir, "trajectories")` *before* spawning the runtime.
2. Or, more cleanly, add a new `--run-dir <dir>` flag that controls everything: report path, trajectory dir, JSONL output.

**File:** `packages/scenario-runner/src/executor.ts`
1. Inject `runId` and `scenarioId` into the recorder's start call so the JSONL aggregator can correlate. Today, the recorder doesn't take per-trajectory metadata — extend `StartTrajectoryInput` (`trajectory-recorder.ts:166-170`) with optional `runId?: string`, `scenarioId?: string`, then propagate through `services/message.ts:3882-3894` from a runtime-level slot.
2. For minimal patch, set `process.env.MILADY_LIFEOPS_RUN_ID` and `MILADY_LIFEOPS_SCENARIO_ID` before each scenario run, and have the recorder read them inside `startTrajectory`. Less invasive than threading params, but couples the recorder to scenario semantics — go with the explicit threading.

### F.7 Lifeops benchmark runner: surface tokens per case

**File:** `plugins/app-lifeops/test/helpers/lifeops-prompt-benchmark-runner.ts`
1. Line 26-38: extend `PromptBenchmarkResult` with `inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`, `cacheHitPct`.
2. Line 208-270 (`captureTrajectoryForCase`): when iterating `trajectory.steps[*].llmCalls`, sum cache fields onto the result.

---

## G. Open / non-blocking notes

- **Cache normalizer duplication.** `cache-observation.ts` and `cache-observer.ts` both define `normalizeCacheUsage` and `CacheUsageObservation`. Pick one, delete the other, and re-export. Existing imports both target `./cache-observation` (no current consumer of `cache-observer.ts` outside its tests) — confirm before deletion.
- **`MODEL_USED` event is dead code.** `EventType.MODEL_USED` is declared (`types/events.ts:59`, `:447`) but never emitted. Either wire it (with the fixed payload that carries cache tokens) or delete the type — Legacy Code Removal Agent territory.
- **DB trajectory pipeline** has cache fields too (`agent/src/runtime/trajectory-storage.ts:140-151`) but no per-phase taxonomy. Don't extend it — let the JSON recorder be the single source of truth for per-phase telemetry, keep DB for the dashboard list view.
- **Evaluator confidence** is not produced by the current evaluator (`runtime/evaluator.ts`). If/when an evaluator emits it, add to `RecordedEvaluationStage`.

---

## H. Implementation order for the follow-up agent

1. Fix `cacheHitRate` denominator (`cache-observation.ts:147-159` and `:194-197`) and harness display (`trajectory-harness.ts:333-346`). Tiny, isolated.
2. Add `toolSearch` to `RecordedStageKind` and extend `RecordedStage` (`trajectory-recorder.ts:33-134`).
3. Add `recordToolSearchStage` and call it from `services/message.ts:1641-1716`. Thread `recorder`/`trajectoryId` into `buildV5PlannerActionSurface`.
4. Add `retryIdx` to `RecordedStage` and populate it from the planner retry loop (`planner-loop.ts:1252`).
5. Add `runId` + `scenarioId` to `StartTrajectoryInput`, propagate from `services/message.ts:3882-3894`.
6. Add `--run-dir` to `scenario-runner/src/cli.ts`; set `MILADY_TRAJECTORY_DIR` accordingly; pass `runId` to executor and into `recorder.startTrajectory`.
7. Build `scripts/aggregate-lifeops-run.mjs` modelled on `scripts/analyze-trajectories.mjs`. Output `run.jsonl`, `report.md`, `steps.csv`.
8. Extend `lifeops-prompt-benchmark-runner.ts` `PromptBenchmarkResult` with cache fields.
9. Optionally collapse `cache-observer.ts` into `cache-observation.ts` (or vice versa).

Each step compiles in isolation; (1)–(4) are recorder schema, (5)–(6) are plumbing, (7)–(8) are reporting.
