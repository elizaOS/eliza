# Pipeline hooks

Single reference for **`registerPipelineHook` / `applyPipelineHooks`**: every phase (incoming, should-respond, **outgoing text**, model, memory, streaming), **why** they exist, stream dedupe on Node, optional DPE (dynamic prompt optimization) persistence, and how to extend safely.

Types live in `src/types/pipeline-hooks.ts` (exported from `@elizaos/core`). Handlers receive a **discriminated** `PipelineHookContext` keyed by `phase`.

---

## Why one hook system

- **Predictability:** One registration pattern (ordered by `position`, replace-by-`id`) instead of many runtime-specific callbacks.
- **Observability:** Each invocation can emit `EventType.PIPELINE_HOOK_METRIC` with `hookId`, `phase`, `durationMs`, `roomId`, and `slow` (when duration ≥ `PIPELINE_HOOK_WARN_MS`). Subscribe with `runtime.registerEvent(EventType.PIPELINE_HOOK_METRIC, …)`. Slow hooks also get warn / error-level logs (`PIPELINE_HOOK_ERROR_LOG_MS`). **Why:** Production triage needs comparable timings across phases without custom metrics per feature.
- **Ordering:** Most phases use provider-style `position` + `schedule` + mutator buckets; `parallel_with_should_respond` runs **concurrently** in one `Promise.all`. **Why:** Latency-sensitive probes can overlap; serial mutators elsewhere reduce races.

---

## Phases (summary)

| Area | Phases | Why |
|------|--------|-----|
| Turn | `incoming_before_compose`, `pre_should_respond`, `parallel_with_should_respond` | Normalize or enrich the message before composition and gating. |
| Model | `pre_model`, `post_model` | Policy and inspection **around** `useModel` without forking adapters. |
| Memory | `after_memory_persisted` | Run after `createMemory` commits with **persisted** `memory.id` (filter `tableName` if you only care about `messages`). |
| Stream | `model_stream_chunk`, `model_stream_end` | Incremental UX and metrics; `model_stream_end` closes a leg before `post_model` or on action stream end. |
| Outgoing | `outgoing_before_deliver` | User-visible text before callback and persistence — [full detail below](#outgoing-user-visible-text-before-delivery). |

Helpers such as `preModelPipelineHookContext`, `outgoingPipelineHookContext`, `modelStreamChunkPipelineHookContext`, etc., build the correct `phase` + fields for each call site.

---

## Outgoing: user-visible text before delivery (`outgoing_before_deliver`)

Post-processing of reply text **before** the handler callback and related memory writes. Same metrics and ordering rules as other phases.

### API

- `runtime.registerPipelineHook({ id, phase: "outgoing_before_deliver", handler, ... })` — same `id` replaces the previous handler for that id (any phase).
- `runtime.unregisterPipelineHook(id)`
- `await runtime.applyPipelineHooks("outgoing_before_deliver", outgoingPipelineHookContext(content, ctx))` — runs handlers, then coerces `content.text` and applies `redactSecrets`.

Import `outgoingPipelineHookContext` from `@elizaos/core` (or `../types/pipeline-hooks` in-repo). Types: `OutgoingContentSource`, `OutgoingContentContext`, `PipelineHookContext`, `PipelineHookSpec`.

### Behavior

| Aspect | Behavior |
|--------|----------|
| Order | `position` ascending, then `id`; see `PipelineHookSpec` for `schedule` / `mutatesPrimary` |
| Identity | Re-registering the same `id` replaces the handler |
| Errors | Throwing hook: runtime logs and continues |
| Secrets | After all hooks: coerce + `redactSecrets` on `content.text` |
| Streaming | Set `streaming` on the outgoing context so cosmetic hooks can skip partials |

### `source` values (core call sites)

| `source` | When |
|----------|------|
| `simple` | Main pipeline: simple reply after final content is ready |
| `action` | Planned tool execution immediately before each action `callback` |
| `continuation_simple` | Post-action / reflection continuation in simple mode |
| `excluded` | Terminal IGNORE/STOP-style payloads and autonomy STOP |
| `evaluate` | Evaluator-driven callback from the main message handler |
| `autonomy_simple` / `autonomy_evaluate` | `runAutonomyPostResponse` simple path and evaluate callback |

Extensions should use `OutgoingContentSource` strings consistent with the union for typing and logging.

### Example

```typescript
import type { Plugin } from "@elizaos/core";
import { outgoingPipelineHookContext } from "@elizaos/core";

export const myPlugin: Plugin = {
  name: "my-plugin",
  description: "Example",
  async init(_config, runtime) {
    runtime.registerPipelineHook({
      id: "my-plugin:sign",
      phase: "outgoing_before_deliver",
      handler: async (_rt, ctx) => {
        if (ctx.phase !== "outgoing_before_deliver") return;
        if (ctx.source === "excluded" || ctx.streaming) return;
        const t = ctx.content.text;
        if (typeof t !== "string" || !t.trim()) return;
        ctx.content.text = `${t}\n\n— bot`;
      },
    });
  },
  dispose(runtime) {
    runtime.unregisterPipelineHook("my-plugin:sign");
  },
};
```

Call sites use `applyPipelineHooks("outgoing_before_deliver", outgoingPipelineHookContext(content, { source, roomId, ... }))`.

### Out of scope here

- TTS / audio (`HOOK_MESSAGE_SENDING`, voice attachments)
- Rust / Python parity
- Per-room `plain: true` (see roadmap if added)

---

## Stream hook dedupe (Node)

The same provider chunk can be delivered from **`useModel`**’s `textStream` loop **and** from **`DefaultMessageService`**. Running `model_stream_chunk` twice would double telemetry and side effects.

**Mechanism:** `runInsideModelStreamChunkDelivery` in `streaming-context.ts` bumps AsyncLocalStorage depth while `useModel` invokes chunk callbacks. While depth is greater than zero, the message service **skips** its own `model_stream_chunk` with `source: "message_service"`.

**Why AsyncLocalStorage (not a global flag):** Nested async work must stay scoped to the in-flight chunk; a boolean would leak across concurrent turns. Non-Node builds have no ALS store here; depth stays `0` (no skip).

---

## Dynamic prompt execution optimization (DPE)

When templates are merged or executed dynamically, the runtime can record **`ExecutionTrace`** rows (JSON-friendly payloads with **`ScoreCardData`**) and optional **registry** writes. **Why:** Offline analysis and A/B comparison without blocking the hot path on heavy I/O.

- **`ExecutionTrace`:** Model slot, hashes, validation flags, latency, embedded `scoreCard`, `traceVersion` for forward-compatible parsers.
- **`ScoreSignal` / `ScoreCard`:** Weighted **`composite`** score; optional **`traceId`** on a signal so `enrichTrace` updates one trace row.
- **`PromptOptimizationRuntimeHooks`:** `mergePromptTemplate`, `persistRegistryEntry`, `appendBaselineTrace`, `appendFailureTrace` — async, split baseline vs failure so sinks/retention can differ.

**`DEFAULT_SIGNAL_WEIGHTS`:** Central weights for `source:kind` in `ScoreCard.composite`; overrides per constructor or `composite()`.

Types: `src/types/prompt-optimization-*.ts`.

---

## Contributor checklist

1. New **phase:** extend `PipelineHookPhase` and `PipelineHookContextForPhase` in `pipeline-hooks.ts` (exhaustive typing catches missed call sites).
2. Document **why** the phase exists and whether it is high-frequency (defaults differ for `model_stream_chunk` telemetry).
3. Tests: `src/__tests__/model-and-memory-pipeline-hooks.test.ts` (or focused tests); **CHANGELOG** with a **Why** bullet.
4. Streaming changes: verify `runInsideModelStreamChunkDelivery` / `getModelStreamChunkDeliveryDepth`.
5. **DPE:** keep `ExecutionTrace` backward-compatible where possible; update this doc and `CHANGELOG.md` if operators must change sinks.
