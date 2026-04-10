# Prompt optimization, traces, and artifacts

This document explains **how** on-disk prompt optimization works in `@elizaos/core` and **why** each piece exists. It complements `src/optimization/` and `plugin-neuro`.

---

## Goals

1. **Observe** structured LLM calls (`dynamicPromptExecFromState` / DPE): parse success, retries, latency, token use, and optional quality signals.
2. **Improve** prompts over time via `OptimizationRunner` (few-shot demos, future GEPA/ACE wiring).
3. **Experiment safely** with A/B traffic between baseline and optimized prompts once an `artifact.json` exists.

**Why file-based?** Optimizations are tied to `(modelId, slotKey, promptKey)` and should be **portable** across agents: copy `OPTIMIZATION_DIR`, version in git, or share a directory—without coupling to a specific DB row.

---

## Directory layout (`OPTIMIZATION_DIR`)

Default: `~/.eliza/optimization/` if `OPTIMIZATION_DIR` is unset.

```
<OPTIMIZATION_DIR>/
  _prompt_registry/
    <promptKey>__<schemaFingerprint>.json   # template + schema for runner
  <sanitizedModelId>/
    <slotKey>/
      history.jsonl                         # append-only traces
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

---

## Data flow

### 1. DPE success / failure (`runtime.ts`)

When `PROMPT_OPTIMIZATION_ENABLED` is on:

- Builds `ExecutionTrace` (scores, variant, `promptKey`, `modelSlot`, `modelId`, etc.).
- Registers **active traces** by `runId` for `plugin-neuro` to enrich (length, latency, reactions, …).
- **`writePromptRegistryEntry`** — stores full `promptTemplate` + `schema` under `_prompt_registry/`.

**Why a registry?** Trace lines store hashes and metadata; the **runner** needs the original template and schema to run optimization. Reconstructing from traces alone is unreliable.

**Why write registry from DPE, not only from the runner?** DPE already has the rendered template context; the finalizer should not duplicate template capture logic.

### 2. RUN_ENDED (`plugin-neuro` finalizer)

- Loads active traces for the run.
- Appends **enriched** trace to `history.jsonl` (higher `seq` than DPE baseline so dedup keeps enriched rows).
- **`await SlotProfileManager.recordTrace`** — updates rolling stats and `needsReoptimization`.
- **`maybeRunAutoPromptOptimization` at most once per dedupe key** (`modelId` + `modelSlot` + `promptKey` + `schemaFingerprint`) for the whole batch, not once per trace line.

**Why `await` inside `recordTrace`?** Previously the write lock ran fire-and-forget; the finalizer could call `maybeRunAutoPromptOptimization` **before** the profile row was updated, so the auto runner always saw stale `needsReoptimization`. Awaiting the lock makes profile state consistent before background optimization.

**Why dedupe auto-opt per RUN_ENDED?** A single user message can produce several DPE traces (planner + continuation + reply). Scheduling auto-opt for every trace queued multiple full `OptimizationRunner` runs back-to-back for the same prompt key.

**Why invalidate the singleton profile cache after `markOptimized`?** `OptimizationRunner` updates disk via its **own** `SlotProfileManager` instance (isolated from hot-path locks). Without invalidating the process singleton used by `getSlotProfileManager`, the next auto-opt still saw `needsReoptimization: true` in memory and ran the pipeline again.

### 3. Auto optimization (`auto-optimizer.ts`)

After `recordTrace`, `maybeRunAutoPromptOptimization` may run `OptimizationRunner` when:

- `isPromptOptimizationEnabled()` is true, and
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
| `PROMPT_OPTIMIZATION_ENABLED` | Master switch: DPE traces, registry, neuro hooks, auto runner eligibility. |
| `OPTIMIZATION_DIR` | Root for traces, profiles, artifacts, registry (optional). |

**Why no separate “auto artifact” flag?** Product choice: when optimization is on, background runs are part of the same feature; disabling optimization disables the whole pipeline.

---

## Related code

| Area | Path |
|------|------|
| DPE + trace emission | `src/runtime.ts` |
| Registry | `src/optimization/prompt-registry.ts` |
| Profiles + thresholds | `src/optimization/slot-profile.ts`, `src/optimization/types.ts` (`SLOT_PROFILE_DEFAULTS`) |
| Runner + artifact format | `src/optimization/runner.ts`, `src/optimization/resolver.ts` |
| Auto runner | `src/optimization/auto-optimizer.ts` |
| Finalizer | `src/plugin-neuro/handlers/finalizer.ts` |
| TOON helpers | `src/utils/toon.ts` |
| Parse entry | `src/utils.ts` (`parseKeyValueXml`) |

---

## Further reading

- **Optimizer pipeline and future phases:** [`src/optimization/ROADMAP.md`](../src/optimization/ROADMAP.md)
- **Package changelog:** [`CHANGELOG.md`](../CHANGELOG.md) (Unreleased / recent entries)
- **LLM call routing (DPE vs `useModel`):** [LLM_ROUTING.md](./LLM_ROUTING.md)
