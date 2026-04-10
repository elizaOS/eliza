# Changelog

All notable changes to the Prompt Optimization System.

## [Unreleased] — 2026-04-09

### Round 7 — Final Fixes

**Singleton initialization-order bug** (`index.ts`)
- When `signalWeights` is provided after singletons were already created without
  weights, the weight-dependent singletons (`SlotProfileManager`, `ABAnalyzer`)
  are now invalidated and recreated. Previously, they silently used `undefined`
  weights forever.

**Baseline trace snapshot timing** (`trace-writer.ts`)
- `JSON.stringify` now runs *before* `await ensureDir()` in `append()`, so
  fire-and-forget callers get a frozen snapshot at call time. Previously, the
  object could be mutated by evaluators during the async gap between the call
  and serialization.

### Round 6 — Continuation & Partial Finalization

**CRITICAL: Continuation signal ordering** (`plugin-neuro/evaluator.ts`)
- `enrichContinuationSignals` now runs *before* `trackAgentResponse`, so it
  reads the **previous** turn's entry before it gets overwritten. The prior
  ordering attributed signals to the wrong turn.

**IMPORTANT: Partial finalizer failure** (`runtime.ts`, `finalizer.ts`)
- Added `deleteActiveTraceById(traceId)` to support per-trace cleanup. If some
  traces in a multi-DPE run fail to persist, only the successful ones are
  removed from memory. Failed traces remain for TTL cleanup instead of being
  silently dropped.

**MODERATE: Length signal attribution** (`evaluator.ts`)
- Length signal now attaches to the last trace (the reply) directly, instead of
  broadcasting to all traces in a run.

**MODERATE: Nested array path resolution** (`ax-bootstrap.ts`)
- `resolveNestedValue` now correctly handles paths like `items[].child` by
  recursively mapping over array elements.

### Round 5 — Multi-Trace & Signal Accuracy

**CRITICAL: Continuation signals lost** (`evaluator.ts`)
- Swapped `trackAgentResponse` and `enrichContinuationSignals` call order.
  (This was re-fixed in Round 6 due to an accidental revert.)

**CRITICAL: Partial finalizer deleted ALL traces** (`finalizer.ts`)
- Introduced per-trace deletion to preserve unpersisted traces.

**IMPORTANT: Runner accepted empty training set** (`runner.ts`)
- Added explicit guard and error message when no non-optimized traces are
  available for training.

**IMPORTANT: `signalWeights` not propagated to singletons** (`index.ts`)
- `ensureInitialized` now tracks the most specific weights and applies them
  when creating singletons. (Further fixed in Round 7.)

**MODERATE: Latency broadcast to all traces** (`evaluator.ts`)
- Latency signals now pushed per-trace using each trace's own `latencyMs`.

**MODERATE: `ABAnalyzer` per-instance locks** (`index.ts`, `finalizer.ts`)
- Introduced `getABAnalyzer()` singleton to share analysis locks across calls.

**MODERATE: `resolveNestedValue` for array paths** (`ax-bootstrap.ts`)
- Updated to handle `[]` path segments with recursive mapping.

**MODERATE: `OPTIMIZATION_TRACE` only for last trace** (`finalizer.ts`)
- Now emits one event per successfully persisted trace.

**MINOR: Failure traces missing `seq`** (`runtime.ts`)
- Failure-path traces now get `trace.seq = failTw.nextSeq()`.

### Round 4 — Trace Ordering & Multi-DPE

**CRITICAL: Baseline vs enriched write ordering race** (`trace-writer.ts`, `types.ts`)
- Added `seq: number` to `ExecutionTrace` for monotonic ordering. `loadTraces`
  deduplicates by `trace.id` and keeps the highest `seq`, guaranteeing the
  enriched copy wins regardless of I/O ordering.
- Added per-path write serialization via `withWriteLock` in `TraceWriter`.

**IMPORTANT: `activeTraces` keyed by `runId` — multi-DPE collision** (`runtime.ts`)
- Rekeyed `activeTraces` by `trace.id` (uuid). Added `runToTraces` map from
  `runId` → `Set<traceId>`. `enrichTrace` now applies to all traces in a run.
  Added `getActiveTracesForRun` to `IAgentRuntime`.

**IMPORTANT: `compositeOf` inconsistency in A/B analysis** (`ab-analysis.ts`)
- `compositeOf` now always recomputes from `scoreCard.signals` with provided
  `signalWeights`, returning `0` for empty/missing signals.

**MODERATE: Continuation handler on dead event** (`plugin-neuro`)
- Moved continuation detection from `MESSAGE_RECEIVED` event handler to the
  evaluator, which receives the message directly.

**MODERATE: `SlotProfileManager` ignored `signalWeights`** (`runner.ts`, `index.ts`)
- Runner now passes weights to `SlotProfileManager`. `index.ts` singleton
  captures the most specific weights.

**MODERATE: Runner included optimized traces in fallback** (`runner.ts`)
- Training trace fallback now explicitly filters `variant !== "optimized"`.

**MODERATE: `ScoreCard.fromJSON` crash on malformed input** (`score-card.ts`)
- Added `Array.isArray` and null guards to `fromJSON` and `addAll`.

**MODERATE: `stripMergedContent` regex too greedy** (`merge.ts`)
- Tightened regex to require markers on their own lines (`(?:^|\n)` prefix).

**MINOR: `composite()` NaN propagation** (`score-card.ts`)
- Skips signals with non-number or `NaN` values.

**MINOR: `composite({})` dropped instance weights** (`score-card.ts`)
- Weight resolution now correctly merges instance and call-level overrides.

### Round 3 — Race Conditions & Safety

**CRITICAL: Evaluator/finalizer race** (`services/message.ts`)
- Changed `void runEvaluate()` to `await runEvaluate()` for all message paths,
  ensuring evaluators complete before `RUN_ENDED` fires.

**IMPORTANT: `adopted: false` missing on empty demos** (`ax-bootstrap.ts`)
- Bootstrap adapter now returns `adopted: false` when no qualifying demos
  exist, preventing pipeline from adopting a zero score.

**IMPORTANT: `compositeOf` crash on legacy traces** (`ab-analysis.ts`)
- Added `Array.isArray(signals)` guard with optional chaining.

**IMPORTANT: Success traces lost without plugin-neuro** (`runtime.ts`)
- DPE now writes a baseline trace directly to disk. Finalizer writes the
  enriched version; dedup ensures the enriched copy prevails.

**MODERATE: LRU cache write didn't refresh position** (`resolver.ts`)
- Added `cache.delete` before `cache.set` on writes.

**MODERATE: `OPTIMIZATION_TRACE` emitted on failed persistence** (`finalizer.ts`)
- Moved event emission inside the `if (persisted)` block.

### Round 2 — Signal Weights & A/B Robustness

**IMPORTANT: Signal weight consistency in A/B comparisons**
- All composite score computations in A/B paths now use the same
  `signalWeights`, eliminating mixed-scoring artifacts.

**IMPORTANT: File I/O error handling** (`resolver.ts`, `slot-profile.ts`)
- Disk read errors return null/empty instead of crashing.

**MODERATE: Stale dedup comments** (`trace-writer.ts`)
- Updated to reflect current design.

### Round 1 — Initial Audit Fixes (19 issues)

**Scoping & type fixes:**
- `schemaValidation` variable hoisted out of dead scope in DPE success path.
- Plugin-neuro handlers fixed to accept single payload argument.
- `neuroEvaluator.handler` return type aligned with `Handler` interface.
- `OptimizationTracePayload` runtime field added to finalizer emit.

**Data integrity:**
- `SlotProfileManager` latency histogram moved to per-slot `Map`.
- `SlotProfileManager` signal average initialization fixed for first observation.
- `ScoreCard.signals` getter returns `readonly` array.
- `resolver.ts` A/B selection uses deterministic counter instead of `Date.now()`.

**Metric accuracy:**
- `schemaValid` score checks both `missingPaths` and `invalidPaths`.
- Welch's t-test replaced normal approximation with t-distribution CDF.

**Plugin-neuro correctness:**
- `neuroEvaluator.validate()` checks `message.entityId !== runtime.agentId`.
- `handleContinuation` sender check uses `entityId` instead of `userId`.

**Memory management:**
- TTL-based pruning of `activeTraces` (5-minute expiry).

**Cleanup:**
- Removed unused imports across all modules.
- Unified duplicate TTL constants.

## [0.1.0] — Initial Implementation

- Core types and data structures (`ExecutionTrace`, `ScoreCard`, etc.)
- On-disk persistence with `history.jsonl` and `artifact.json`
- Write-through LRU cache for artifact resolution
- A/B testing with Welch's t-test
- Three-stage optimizer pipeline (AxBootstrapFewShot → AxGEPA → AxACE)
- Plugin-neuro for user-facing quality signals
- Integration with `dynamicPromptExecFromState` in runtime.ts
- 32-test suite covering core modules
