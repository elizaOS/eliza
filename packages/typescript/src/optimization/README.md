# Prompt Optimization System

A programmatic prompt optimization framework for Eliza's `dynamicPromptExecFromState` (DPE). Instead of hand-tuning prompts, this system collects execution traces, scores them with multi-signal feedback, and iteratively improves instructions, few-shot demos, and playbooks — all transparently, with no changes required to existing agent code.

## Why This Exists

LLM prompts degrade silently. A prompt that works well for GPT-4 may fail for a smaller model. A prompt that handles English conversations may struggle with code generation. Manual tuning doesn't scale across models, slots, and use cases.

This system treats prompts as optimizable programs (inspired by [DSPy](https://github.com/stanfordnlp/dspy)). Every DPE call produces a scored trace. Over time, those traces feed an optimization pipeline that generates improved prompt artifacts. A/B testing ensures optimized prompts actually perform better before full promotion.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        runtime.ts (DPE)                        │
│                                                                 │
│  1. Resolve artifact (instructions/demos/playbook)              │
│  2. Merge into prompt template                                  │
│  3. Call LLM                                                    │
│  4. Score result (schema validity, parse success, retries)       │
│  5. Write baseline trace to disk                                │
│  6. Store trace in memory for enrichment                        │
└──────────┬──────────────────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────────────────┐
│                      plugin-neuro (evaluator)                   │
│                                                                 │
│  7. Score response quality (length, latency, continuation)      │
│  8. Detect user corrections / engagement signals                │
│  9. Map emoji reactions to sentiment scores                     │
│ 10. Push signals to in-memory traces                            │
└──────────┬──────────────────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────────────────┐
│                      plugin-neuro (finalizer)                   │
│                                                                 │
│ 11. Recompute composite score with all signals                  │
│ 12. Write enriched trace (higher seq → wins dedup)              │
│ 13. Update slot profile statistics                              │
│ 14. Trigger A/B analysis if enough samples                      │
│ 15. Emit OPTIMIZATION_TRACE event                               │
└──────────┬──────────────────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────────────────┐
│                     OptimizationRunner                          │
│                                                                 │
│ 16. Load training traces (baseline only)                        │
│ 17. Run pipeline: AxBootstrapFewShot → AxGEPA → AxACE          │
│ 18. Write optimized artifact to disk                            │
│ 19. A/B test against baseline at 50/50 traffic split            │
│ 20. Auto-promote or rollback based on Welch's t-test            │
└─────────────────────────────────────────────────────────────────┘
```

## Directory Layout

Artifacts and traces persist on disk at `~/.eliza/optimization/` (configurable via `OPTIMIZATION_DIR` setting):

```
~/.eliza/optimization/
  ├── gpt-4o-mini/                    # sanitized model_id (provider string)
  │   ├── SMALL/                      # model slot (capability tier)
  │   │   ├── history.jsonl           # append-only trace + run + decision log
  │   │   ├── artifact.json           # { promptKey: OptimizedPromptArtifact }
  │   │   └── profile_<prompt>.json   # per-prompt rolling stats
  │   └── LARGE/
  │       └── ...
  └── claude-3.5-sonnet/
      └── ...
```

**Why model-first?** Models are the highest-cardinality axis. An optimization for `gpt-4o-mini/SMALL` is useless for `claude-3.5-sonnet/SMALL`. Grouping by model makes it trivial to share or transfer optimization data between projects that use the same model.

**Why on disk, not in DB?** Optimizations are universal across agents — a well-tuned `shouldRespond` prompt benefits every agent using that model/slot. File-based storage enables copying between projects and avoids coupling to Eliza's database layer.

## Key Concepts

### Execution Traces

Every DPE call produces an `ExecutionTrace` — a complete record of what happened:

- **Structural signals**: `parseSuccess`, `schemaValid`, `validationCodesMatched`, `retriesUsed`, `tokenEstimate`
- **Timing**: `latencyMs`, `createdAt`
- **Identity**: `modelId`, `modelSlot`, `promptKey`, `templateHash`, `runId`
- **A/B variant**: `"baseline"` or `"optimized"`
- **ScoreCard**: accumulated `ScoreSignal[]` with weighted composite

### ScoreCard & Signals

A `ScoreCard` accumulates diverse quality signals from multiple sources:

| Source | Signal | Why |
|--------|--------|-----|
| DPE | `dpe:schema_valid` | Did the output match the expected schema? |
| DPE | `dpe:parse_success` | Did JSON parsing succeed? |
| DPE | `dpe:validation_codes_matched` | Were required validation codes present? |
| DPE | `dpe:retries_used` | Fewer retries = more reliable prompt |
| neuro | `neuro:length_appropriateness` | Is the response length reasonable vs rolling median? |
| neuro | `neuro:response_latency` | Is the model responding in reasonable time? |
| neuro | `neuro:user_continuation` | Did the user keep talking? (engagement proxy) |
| neuro | `neuro:user_correction` | Did the user correct the agent? (quality anti-signal) |
| neuro | `neuro:reaction_positive/negative/neutral` | Emoji reaction sentiment |

Composite scores use configurable per-signal weights with a sensible default hierarchy.

### A/B Testing

New artifacts start at 50/50 traffic split. The resolver deterministically assigns each request to `"baseline"` or `"optimized"` variant. After enough samples accumulate (`minSamples: 30` per variant), a **Welch's t-test** with full t-distribution CDF determines whether the optimized variant is statistically better:

- **p < 0.05 and optimized wins** → auto-promote (traffic split → 1.0)
- **p < 0.05 and baseline wins** → auto-rollback (traffic split → 0.0)
- **p ≥ 0.05** → inconclusive, keep testing

### Trace Deduplication

DPE writes a baseline trace immediately (fire-and-forget). Plugin-neuro's finalizer later writes an enriched version with more signals. Both share the same `trace.id` but different monotonic `seq` numbers. `loadTraces` keeps the highest `seq` per id, guaranteeing the enriched version wins regardless of I/O ordering.

## Modules

| Module | Purpose |
|--------|---------|
| `types.ts` | Core data structures and interfaces |
| `score-card.ts` | Weighted signal aggregation |
| `trace-writer.ts` | Append-only JSONL persistence with write locks |
| `resolver.ts` | Artifact read/write with LRU cache and A/B selection |
| `merge.ts` | Inject optimized content into prompt templates |
| `ab-analysis.ts` | Welch's t-test and decision logic |
| `ab-analyzer.ts` | Orchestrates when to run A/B analysis |
| `pipeline.ts` | Multi-stage optimizer pipeline |
| `runner.ts` | End-to-end optimization entry point |
| `slot-profile.ts` | Per-slot statistics and re-optimization triggers |
| `index.ts` | Public API and process-wide singletons |
| `adapters/` | Ax-based optimizer adapters (bootstrap, GEPA, ACE) |

| Plugin Module | Purpose |
|---------------|---------|
| `plugin-neuro/evaluator.ts` | Post-response quality signals |
| `plugin-neuro/handlers/continuation.ts` | User engagement tracking |
| `plugin-neuro/handlers/reaction.ts` | Emoji sentiment mapping |
| `plugin-neuro/handlers/finalizer.ts` | Trace finalization on RUN_ENDED |
| `plugin-neuro/signals.ts` | Signal name constants |

## Usage

### Enabling Optimization

Optimization activates automatically when DPE has a resolved `modelId` and `promptKey`. The `promptKey` is derived from the prompt name (if provided) or a hash of the schema.

### Enabling Plugin-Neuro

Add `neuroPlugin` to your character's plugin list for richer quality signals:

```typescript
import { neuroPlugin } from "./plugin-neuro/index.ts";

const character = {
  plugins: [neuroPlugin],
  settings: {
    // Optional: custom signal weights
    PROMPT_OPT_SIGNAL_WEIGHTS: JSON.stringify({
      "dpe:schema_valid": 2.0,
      "neuro:user_correction": 1.5,
    }),
    // Optional: custom storage directory
    OPTIMIZATION_DIR: "/path/to/optimization",
  },
};
```

### Running Optimization

```typescript
import { OptimizationRunner } from "./optimization/index.ts";

const runner = new OptimizationRunner();
const result = await runner.run({
  rootDir: "~/.eliza/optimization",
  modelId: "gpt-4o-mini",
  slotKey: "SMALL",
  promptKey: "shouldRespond",
  promptTemplate: "You are a helpful assistant...",
  schema: [{ name: "shouldRespond", type: "boolean" }],
  signalWeights: { "dpe:schema_valid": 2.0 },
});

console.log(result.baselineScore, "->", result.finalScore);
```

### Checking for Pending Optimizations

```typescript
const runner = new OptimizationRunner();
const pending = await runner.listPendingOptimizations("~/.eliza/optimization");
// [{ modelId: "gpt-4o-mini", slotKey: "SMALL", promptKey: "shouldRespond" }]
```

## Testing

```bash
npx vitest run packages/typescript/src/__tests__/optimization.test.ts
```

32 tests covering ScoreCard, merge, resolver, trace writer, A/B analysis, and end-to-end integration.
