# Prompt optimization, traces, and artifacts

This document explains **how** prompt optimization fits together and **why** each piece exists.

- **`@elizaos/core`:** DPE builds `ExecutionTrace` objects and calls **`PromptOptimizationRuntimeHooks`** when registered (`registerPromptOptimizationHooks`). Core holds in-memory traces for enrichment; it does **not** read `PROMPT_OPTIMIZATION_ENABLED` or perform disk I/O for merge/registry/traces.
- **`@elizaos/plugin-promptopt`:** Default disk hooks, prompt registry, `history.jsonl`, neuro quality signals, RUN_ENDED finalizer, A/B, auto-optimization, and optional GEPA/ACE (`@ax-llm/ax`). The plugin registers hooks in `init` when `PROMPT_OPTIMIZATION_ENABLED` is truthy.

### Core vs plugin — responsibility split (WHY)

| Concern | Where it lives | Why |
|--------|----------------|-----|
| Structured DPE, parse/retry, in-memory `activeTraces` / `runToTraces`, `enrichTrace` | **`@elizaos/core`** | Hot path must stay small and testable; correlation IDs are runtime-owned whether or not disk exists. |
| **Operator flag** `PROMPT_OPTIMIZATION_ENABLED` | **Plugin + harness only** | Core stays policy-neutral: same binary can run benchmarks, tests, or minimal agents without implying “optimization is on.” Harness may still copy env into `character.settings` so `.env` matches DB merge timing. |
| **`PromptOptimizationRuntimeHooks`** | **`@elizaos/core` (interface)** | One stable extension point: custom disk, remote registry, or mocks without forking DPE. |
| Default merge / registry / baseline & failure traces | **`@elizaos/plugin-promptopt`** | Node `fs`, resolver LRU, trace locks, and Ax live here; keeps browser/core bundles from pulling `node:fs` on the DPE path. |
| RUN_ENDED enriched writes, slot profiles, A/B, auto-runner | **Plugin** (same package as hooks today) | Same process singletons as before the split; finalizer still uses `TraceWriter` directly—only DPE was generalized through hooks. **Why not every line through hooks?** Diminishing return vs. a second abstraction layer; DPE was the coupling point to `runtime.ts`. |
| `sanitizeModelId` / `historyJsonlFilePath` | **`@elizaos/core`** | Trajectory JSONL (`TrajectoryLoggerService`) must append to the **same** paths as `TraceWriter` without a **core → plugin** import (would create a dependency cycle or force dynamic imports). **Why duplicate append implementation?** Only the path math is shared; locking strategy still differs slightly, but path drift was the bug class we eliminated. |
| Plugin `dispose` | **`@elizaos/plugin-promptopt`** | Unregisters the **default** hook object on teardown so tests and reloads do not leave stale hooks pointing at an old runtime. **Why identity check?** If another plugin replaced hooks, we must not `null` them out. |

Further reading for the plugin package: [`../../plugin-promptopt/README.md`](../../plugin-promptopt/README.md) and [`../../plugin-promptopt/ROADMAP.md`](../../plugin-promptopt/ROADMAP.md).

---

## Goals

1. **Observe** structured LLM calls (`dynamicPromptExecFromState` / DPE): parse success, retries, latency, token use, and optional quality signals.
2. **Improve** prompts over time via `OptimizationRunner` (few-shot demos, optional GEPA/ACE when `@ax-llm/ax` and `OPTIMIZATION_AI_*` are configured).
3. **Experiment safely** with A/B traffic between baseline and optimized prompts once an `artifact.json` exists.

**Why file-based?** Optimizations are tied to `(modelId, slotKey, promptKey)` and should be **portable** across agents: copy `OPTIMIZATION_DIR`, version in git, or share a directory—without coupling to a specific DB row.

---

## How to verify Phase 4 (GEPA / ACE with real LLMs)

Phase 4 is **not** the same as seeing **`[OPTIMIZED EXAMPLES]`** in DPE logs. That block is **bootstrap / prior artifact demos** merged into the prompt for inference; it does **not** prove that GEPA or ACE ran with remote Ax calls on this machine.

**Phase 4 is active when all of the following hold:**

1. **`@ax-llm/ax`** resolves (installed for `@elizaos/plugin-promptopt` / the agent host).
2. **Settings:** `readOptimizationAIConfig` resolves provider + key + model (explicit `OPTIMIZATION_AI_*` and/or inherited from `OLLAMA_*` / `OPENAI_*` / `ANTHROPIC_*` model env — see `optimization-ai.ts`). With `OPTIMIZATION_AI_INHERIT=false`, all three `OPTIMIZATION_AI_*` must be set explicitly. Otherwise GEPA/ACE stay in stub mode.
3. **An optimization run actually executes:** automatic runs from `auto-optimizer` when thresholds fire, or a manual `OptimizationRunner.run({ runtime, ... })`.

**What to look for at `LOG_LEVEL=debug`:**

| Log / signal | Meaning |
|--------------|---------|
| `src: "optimization:auto"` — “GEPA/ACE may call remote LLMs” | `OPTIMIZATION_AI_*` present; auto run is starting with Phase 4 config. |
| `src: "optimization:auto"` — “GEPA/ACE stubs” | Missing AI settings; pipeline still runs bootstrap but not real Ax optimization. |
| `src: "optimization:runner"` — “OptimizationRunner pipeline inputs” | `phase4AiSettingsPresent: true` and non-empty `studentProvider` / `studentModel`. |
| `src: "optimization:AxGEPA"` / `AxACE` — “invoking Ax.compile” | Ax is about to hit the network for that stage. |
| `instrumentation.jsonl` under the slot directory | Append-only Ax LLM call log when instrumentation is enabled. |
| `history.jsonl` rows with `type: "optimization_run"` | Confirms a runner finished; inspect the linked artifact’s scores and whether stages errored. |

**Artifacts:** `artifact.json` updates after a successful pipeline; empty or unchanged instructions/playbook with warnings in logs usually means stub path, failed compile, or `adopted: false` for that stage.

---

## Directory layout (`OPTIMIZATION_DIR`)

Default: `~/.eliza/optimization/` if `OPTIMIZATION_DIR` is unset.

```
<OPTIMIZATION_DIR>/
  _prompt_registry/
    <promptKey>__<schemaFingerprint>.json   # template + schema for runner
  <sanitizedModelId>/
    <slotKey>/
      history.jsonl                         # append-only union log (see below)
      instrumentation.jsonl                 # optional: Ax GEPA/ACE LLM call log (Phase 4)
      profile_<promptKey>.json              # slot stats + re-opt flags
      artifact.json                         # optimized prompt + A/B config (when present)
```

### Why `modelId` is the **provider model name** (e.g. `lfm2__24b`), not the logical slot

Traces and artifacts must key off the **actual** weights used at inference time.

**Why not `ACTION_PLANNER` as the folder name?** Many setups register `ACTION_PLANNER` but **fallback** to `TEXT_SMALL` in the model registry (no dedicated planner model). If we keyed only by the logical slot, two different real models could overwrite the same optimization history, or you’d optimize for a slot name that never matches production.

**Implementation:** `AgentRuntime.resolveProviderModelString` walks `getModelFallbackChain` (same order as `resolveModelRegistration`) and reads provider-prefixed settings first (`OLLAMA_SMALL_MODEL`, then `SMALL_MODEL`, etc.). **Why the chain:** mirrors plugin-ollama (and similar) resolution so the path matches the model that actually ran.

**Sanitization:** `sanitizeModelId` replaces characters unsafe in paths (e.g. `:` → `__`).

### Why both `modelId` and `slotKey` in the path

- **`slotKey`** (e.g. `ACTION_PLANNER`, `TEXT_LARGE`) distinguishes **which handler** produced the trace (schema + prompt family).
- **`modelId`** distinguishes **which checkpoint** trained the artifact.

Same small model might serve multiple slots; traces per slot stay separate under the same `modelId` folder.

### Correlation ids (joining facts to optimizer traces)

These fields appear on trajectory / observability rows when available:

| Field | Role |
|-------|------|
| `runId` | Agent run / turn grouping (same as on `ExecutionTrace`). |
| `messageId`, `roomId` | Conversation anchors from the active user message. |
| `trajectoryStepId` | Harness or benchmark step id (`message.metadata` + async context). |
| `executionTraceId` | On `llm_observation` / `provider_observation`: latest in-flight DPE trace id for `getCurrentRunId()` when optimization is on; on `signal_context`: same id after finalization. |

`OptimizationRunner` and `loadTraces` still only read **`type: "trace"`** lines. Other types are for replay, debugging, and optional tooling.

### history.jsonl row types (union)

| `type` | Purpose |
|--------|---------|
| `trace` | DPE execution trace (baseline + enriched dedup by `seq`). Training input. |
| `optimization_run` | Record of an `OptimizationRunner` completion. |
| `ab_decision` | A/B promote / rollback / inconclusive. |
| `llm_observation` | Raw `useModel` call (optional; `TRAJECTORY_HISTORY_JSONL`). |
| `provider_observation` | Provider access during compose (optional; stored under slot `PROVIDER_TRACE`). |
| `signal_context` | Post-enrichment `scoreCard` snapshot keyed by `executionTraceId` (optional; duplicates enriched trace scores). |

**Example:** optimizer traces only — `jq 'select(.type=="trace")' history.jsonl`

---

## Architecture: observability vs optimization (first principles)

Three kinds of data are easy to conflate; core keeps them **separate in meaning** while allowing a **single append-only file** per `(modelId, slotKey)`.

| Layer | What it is | On disk / in code | Why separate |
|--------|------------|-------------------|--------------|
| **Facts** | Immutable events: what ran, inputs/outputs | `llm_observation`, `provider_observation` | Replay, compliance, debugging; not the same shape as scored DPE output. |
| **Judgments** | Scores + “why” | `ExecutionTrace.scoreCard`, optional `signal_context` | Training metrics and promotion need **interpreted** quality, not raw tokens alone. |
| **Policy** | Mutable config from optimization | `_prompt_registry/`, `artifact.json`, profiles | Versioned **state** used to choose prompts; not a log line. |

**Why one physical `history.jsonl` union?** One `TraceWriter`, one write-lock per path, and POSIX-friendly append semantics. Consumers that only care about training use `loadTraces()` (filters `type === "trace"`). Others use `jq`, ETL, or future loaders. **Alternative considered:** a sibling `observations.jsonl` — rejected for v1 to avoid two locks and two tail pipelines; revisit if optimizer-only `jq` one-liners become too noisy.

**Why trajectory toggles are not `PROMPT_OPTIMIZATION_ENABLED`?**

- **Optimizer off** must not imply “no observability.” Operators may need raw `useModel` capture for benchmarks without DPE traces or registry writes.
- **Optimizer on** must not imply “write full prompts to disk.” That is PII-heavy and should be **opt-in** via `TRAJECTORY_HISTORY_JSONL`.
- **Why `TRAJECTORY_CAPTURE_ENABLED` default true:** Existing harnesses assume in-memory trajectory logs when `trajectoryStepId` is set; turning capture off is explicit operator choice.

**Why `executionTraceId` on observations is “latest active DPE trace for this run”?** `useModel` and `composeState` are not passed a trace UUID at the call site. The runtime already maintains `activeTraces` keyed by `runId`; **`getActiveTrace(runId)`** returns the most recently registered trace (same order as multi-DPE runs: planner → … → reply). That id is **best-effort correlation**: in a run with several DPE calls, it points at the **last** registered trace, not necessarily the single call that “caused” a subsequent `useModel`. **Why not block on perfect correlation?** Would require threading trace ids through every model entrypoint; deferred until a concrete API need.

**Why optional `signal_context` rows?** Enriched `ExecutionTrace` lines already contain the final `scoreCard`. A separate row keyed by `executionTraceId` lets tools that start from `llm_observation` **join to scores without re-parsing** the full trace document — at the cost of duplication; hence **default off** (`TRAJECTORY_SIGNAL_CONTEXT_JSONL`).

**Why `ScoreSignal.reason`?** Numeric `value` + `kind` is opaque in JSONL and dashboards. Short human-readable reasons (DPE, neuro) make traces auditable without opening code.

**Why a small append helper in core for trajectory JSONL?** `TrajectoryLoggerService` shares the same `history.jsonl` paths as prompt optimization without taking a dependency on the plugin package (avoids a core↔plugin cycle). **`sanitizeModelId`** and **`historyJsonlFilePath`** live in `@elizaos/core` so trajectory append, **`TraceWriter`**, and resolvers all agree on partition paths.

---

## Data flow

### 1. DPE success / failure (`runtime.ts`)

When **`getPromptOptimizationHooks()`** is non-null (typically after `@elizaos/plugin-promptopt` `init` when `PROMPT_OPTIMIZATION_ENABLED` is on):

- Builds `ExecutionTrace` (scores, variant, `promptKey`, `modelSlot`, `modelId`, etc.).
- Registers **active traces** by `runId` for the plugin to enrich (length, latency, reactions, …).
- Hook **`persistRegistryEntry`** — stores full `promptTemplate` + `schema` under `_prompt_registry/` (disk implementation in the plugin).

**Why a registry?** Trace lines store hashes and metadata; the **runner** needs the original template and schema to run optimization. Reconstructing from traces alone is unreliable.

**Why write registry from DPE, not only from the runner?** DPE already has the rendered template context; the finalizer should not duplicate template capture logic.

### 2. RUN_ENDED (plugin finalizer)

- Loads active traces for the run.
- Appends **enriched** trace to `history.jsonl` (higher `seq` than DPE baseline so dedup keeps enriched rows).
- **`await SlotProfileManager.recordTrace`** — updates rolling stats and `needsReoptimization`.
- **`maybeRunAutoPromptOptimization` at most once per dedupe key** (`modelId` + `modelSlot` + `promptKey` + `schemaFingerprint`) for the whole batch, not once per trace line.

**Why `await` inside `recordTrace`?** Previously the write lock ran fire-and-forget; the finalizer could call `maybeRunAutoPromptOptimization` **before** the profile row was updated, so the auto runner always saw stale `needsReoptimization`. Awaiting the lock makes profile state consistent before background optimization.

**Why dedupe auto-opt per RUN_ENDED?** A single user message can produce several DPE traces (planner + continuation + reply). Scheduling auto-opt for every trace queued multiple full `OptimizationRunner` runs back-to-back for the same prompt key.

**Why invalidate the singleton profile cache after `markOptimized`?** `OptimizationRunner` updates disk via its **own** `SlotProfileManager` instance (isolated from hot-path locks). Without invalidating the process singleton used by `getSlotProfileManager`, the next auto-opt still saw `needsReoptimization: true` in memory and ran the pipeline again.

### 3. Auto optimization (`auto-optimizer.ts`)

After `recordTrace`, `maybeRunAutoPromptOptimization` may run `OptimizationRunner` when:

- `runtime.getPromptOptimizationHooks()` is non-null (plugin registered disk hooks), and
- `needsReoptimization` **or** live `shouldReoptimize(profile)` is true (so stale on-disk flags don’t block after threshold changes), and
- registry entry exists, and
- per-key lock / failure cooldown allow it.

**Why background?** Optimization can be slow (Ax/LLM stages); it must not block the message loop.

**Why both logs and disk?** **Info** logs mark start/end and scores; **debug** logs per optimizer stage when `LOG_LEVEL=debug`. `OPTIMIZATION_DIR` still holds the durable artifact, history lines, and profiles for inspection and tooling.

**Why `MIN_TRACES_FIRST_ARTIFACT` (small default)?** First `artifact.json` unlocks A/B and tooling; waiting for dozens of messages made harness and local dev useless. Re-optimization still uses cooldown + `MIN_NEW_TRACES_REOPT`.

### 4. A/B (`ab-analyzer.ts`)

Until `artifact.json` exists, analysis logs **`no_artifact`**. That is expected.

After an artifact exists, traffic may split per `abConfig`; analysis needs enough baseline and optimized samples (`minSamples`, often 30).

---

## Parsing: TOON vs XML (`parseKeyValueXml`)

The function name is historical. **Order today:**

1. **`tryParseToonValue`** (strict `@toon-format/toon` decode).
2. **XML** extraction (`<response>` or first tag block).

**Why XML warning when output “looks like TOON”?**

- If the model output contains `<response>` or `</response>` anywhere, **`looksLikeToonDocument` skips TOON** so we don’t mis-parse hybrid junk.
- Streaming `singleShotReply` uses **`preferredEncapsulation: "xml"`** when `onStreamChunk` is set—models often emit partial XML; TOON may never be attempted on that string.
- **Trailing prose** after a valid TOON document can make **`decode` throw**; the catch returns null, then XML fallback fails → `Could not find XML block`.

**Why not only TOON?** Backward compatibility and models that ignore format instructions; XML path remains a safety net.

---

## Environment and settings

| Key | Role |
|-----|------|
| `PROMPT_OPTIMIZATION_ENABLED` | Master switch **read by `@elizaos/plugin-promptopt`**: register hooks, neuro, RUN_ENDED, auto runner eligibility. **Not read by core.** |
| `OPTIMIZATION_DIR` | Root for traces, profiles, artifacts, registry (optional). |
| `TRAJECTORY_CAPTURE_ENABLED` | When `false`, disables trajectory in-memory + disk capture. Default `true` (backward compatible). |
| `TRAJECTORY_HISTORY_JSONL` | When `true`, appends `llm_observation` / `provider_observation` to `history.jsonl` under `OPTIMIZATION_DIR`. Default `false` (PII). **Independent of** `PROMPT_OPTIMIZATION_ENABLED`. |
| `TRAJECTORY_SIGNAL_CONTEXT_JSONL` | When `true`, finalizer also appends `signal_context` after each enriched trace. Default `false` (avoids duplicating score data already on enriched `trace` rows). |

### Phase 4: AI-powered stages (GEPA / ACE)

When `@ax-llm/ax` is installed **and** `readOptimizationAIConfig` resolves a full student **provider + apiKey + model**, **AxGEPA** and **AxACE** use standalone `AxAI` instances (provider-native API) instead of stubs. Missing `OPTIMIZATION_AI_*` fields are **inherited** from the same env pattern Eliza uses for inference (`OLLAMA_*`, `OPENAI_*`, `ANTHROPIC_*`, then unprefixed `SMALL_MODEL`, with the same fallback-slot walk as `resolveProviderModelString`). Set **`OPTIMIZATION_AI_INHERIT=false`** to require an explicit trio and disable backfill. Optional **`OPTIMIZATION_AI_INHERIT_SLOT`**: `TEXT_SMALL` (default) or `TEXT_LARGE` — which logical slot’s `*_MODEL` keys seed inheritance.

| Key | Required | Purpose |
|-----|----------|---------|
| `OPTIMIZATION_AI_PROVIDER` | For AI stages | Ax provider name. Omitted → inferred from winning `OLLAMA_` / `OPENAI_` / `ANTHROPIC_` model env or from `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / default `ollama`. |
| `OPTIMIZATION_AI_API_KEY` | For AI stages | Omitted → `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `OLLAMA_API_KEY`, else placeholder `ollama` for local Ollama. |
| `OPTIMIZATION_AI_MODEL` | For AI stages | Omitted → first resolved model string for the inherit slot (mirrors inference). |
| `OPTIMIZATION_TEACHER_PROVIDER` | No | Defaults to student provider. |
| `OPTIMIZATION_TEACHER_API_KEY` | No | Defaults to student key. |
| `OPTIMIZATION_TEACHER_MODEL` | No | Defaults to student model. |
| `OPTIMIZATION_INSTRUMENTATION_LEVEL` | No | `full` (default), `summary`, `minimal`, or `off`. Controls what each wrapped `chat()` writes to `instrumentation.jsonl` under the same `(modelId, slotKey)` directory as traces. **`full` may log complete prompts and completions — treat as PII.** |

GEPA/ACE inner metrics use the same **`PROMPT_OPT_SIGNAL_WEIGHTS`** (merged with defaults) as the pipeline baseline, so optimization targets the same composite objective as the rest of the run. On failure (missing package, API error, invalid Ax signature, etc.), the stage falls back to a stub, logs a **warn** with the error message, and records `stats.error` on the stage result for debugging.

**Why standalone AxAI instead of `runtime.useModel`?** GEPA/ACE expect a full `AxAIService` (multi-turn chat, tools, embeddings, streaming). Bridging from Eliza’s string-in/string-out model API would duplicate a provider SDK. Optimization runs offline; separate keys keep the hot path unchanged.

### Phase 4: implementation map (code)

| Piece | Location | WHY |
|-------|----------|-----|
| Read settings → `OptimizationAIConfig` | `../../plugin-promptopt/src/optimization/adapters/optimization-ai.ts` | Single place for trim/validation; **`null`** preserves stub behavior without branching in every adapter. |
| `AxAI.create` + provider string | same | Ax uses a discriminated union on `name`; casting options is the typed escape hatch for **runtime-configured** provider ids. |
| Instrumented student/teacher | `../../plugin-promptopt/src/optimization/adapters/instrumentation.ts` | **WHY wrap only `chat`:** embeds are unused by GEPA/ACE today; logging there would add noise. **WHY async `log`:** append must not block the event loop for long, but we still await so lines are ordered per call. |
| `buildAxProgram` / `buildAxTypedExamples` | `../../plugin-promptopt/src/optimization/adapters/bridge.ts` | **WHY leaf-only schema flattening:** parent `object` rows are not keys in `trace.response`; aligning Ax output fields to **nested paths** (`a.b`, `items[].x`) keeps training examples consistent with `resolveNestedValue`. |
| `createElizaAxMetricFn` + `signalWeights` | same + `../../plugin-promptopt/src/optimization/pipeline.ts` | **WHY not pass `metricFn(trace)` into Ax:** Ax expects **`({ prediction, example }) => number`**; Eliza’s trace metric is a different shape. **WHY pass weights:** without them, Ax would optimize against default weights while baseline/A/B use **`PROMPT_OPT_SIGNAL_WEIGHTS`**. |
| Merge AI options into stages | `../../plugin-promptopt/src/optimization/runner.ts` | **WHY only GEPA/ACE:** bootstrap does not call the LLM; injecting `aiConfig` there would confuse readers and imply unused keys. |
| Forward `runtime` | `../../plugin-promptopt/src/optimization/auto-optimizer.ts` | **WHY required:** auto-opt would never see `OPTIMIZATION_AI_*` if only manual `runner.run()` passed `runtime`. |
| `adopted: false` when output empty | `ax-gepa.ts`, `ax-ace.ts` | **WHY:** avoid bumping **`finalScore`** when the optimizer produced no instructions/playbook text to merge into the artifact. |

**Why parse quirks (empty string, numbers)?** Env and settings layers sometimes yield `""`, `1`, or `0`. Trajectory parsers trim strings, treat **`""` as “unset”** (per-flag default), and accept numeric **0/1** so typed configs behave like booleans. **Why not treat unknown strings as true?** Opt-in flags (`*_HISTORY_JSONL`, `*_SIGNAL_CONTEXT_*`) would accidentally enable PII persistence on typos.

**Why no separate “auto artifact” flag?** Product choice: when optimization is on, background runs are part of the same feature; disabling optimization disables the whole pipeline.

**Trajectory vs optimization:** You can run with optimization off but `TRAJECTORY_HISTORY_JSONL` on to record raw calls; or optimization on without trajectory disk (default).

---

## Related code

| Area | Path |
|------|------|
| DPE + trace emission | `src/runtime.ts` |
| Registry | `../../plugin-promptopt/src/optimization/prompt-registry.ts` |
| Profiles + thresholds | `../../plugin-promptopt/src/optimization/slot-profile.ts`, `../../plugin-promptopt/src/optimization/types.ts` (`SLOT_PROFILE_DEFAULTS`) |
| Runner + artifact format | `../../plugin-promptopt/src/optimization/runner.ts`, `../../plugin-promptopt/src/optimization/resolver.ts` |
| Phase 4 adapters (Ax AI, bridge, instrumentation) | `../../plugin-promptopt/src/optimization/adapters/*.ts` |
| Auto runner | `../../plugin-promptopt/src/optimization/auto-optimizer.ts` |
| Finalizer | `@elizaos/plugin-promptopt` (`neuro/handlers/finalizer.ts`) |
| Trajectory settings | `src/trajectory-settings.ts` |
| Trajectory logger | `src/services/trajectoryLogger.ts` |
| TOON helpers | `src/utils/toon.ts` |
| Parse entry | `src/utils.ts` (`parseKeyValueXml`) |

---

## Further reading

- **Package roadmap (observability follow-ups):** [`ROADMAP.md`](../ROADMAP.md) — split `observations.jsonl`, per-call trace correlation, redaction.
- **Optimizer pipeline and future phases:** [`../../plugin-promptopt/src/optimization/ROADMAP.md`](../../plugin-promptopt/src/optimization/ROADMAP.md) — trajectory rows vs training boundary.
- **Package changelog:** [`CHANGELOG.md`](../CHANGELOG.md) (Unreleased / recent entries)
- **LLM call routing (DPE vs `useModel`):** [LLM_ROUTING.md](./LLM_ROUTING.md)
- **Bool parsing implementation:** [`src/trajectory-settings.ts`](../src/trajectory-settings.ts) (exported from node entry as `isTrajectory*` helpers)
