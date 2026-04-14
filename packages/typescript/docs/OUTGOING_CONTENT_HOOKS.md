# Outgoing pipeline hooks (`outgoing_before_deliver`)

Post-processing of user-visible text before callback and memory (TypeScript runtime).

## API

- `runtime.registerPipelineHook({ id, phase: "outgoing_before_deliver", handler, ... })` — same `id` replaces the previous handler for that id (any phase).
- `runtime.unregisterPipelineHook(id)`
- `await runtime.applyPipelineHooks("outgoing_before_deliver", outgoingPipelineHookContext(content, ctx))` — runs handlers (ordered by `position` / scheduling), then coerces `content.text` and applies `redactSecrets`.

Import `outgoingPipelineHookContext` from `@elizaos/core` (or `../types/pipeline-hooks` in-repo).

Types: `OutgoingContentSource`, `OutgoingContentContext`, `PipelineHookContext`, and `PipelineHookSpec` live in `pipeline-hooks.ts` (package export `@elizaos/core`).

## Observability

Every pipeline hook invocation emits `EventType.PIPELINE_HOOK_METRIC` with `hookId`, `phase`, `durationMs`, `roomId`, and `slow` (true when duration ≥ `PIPELINE_HOOK_WARN_MS`). Subscribe with `runtime.registerEvent(EventType.PIPELINE_HOOK_METRIC, …)`. Slow hooks also get **warn** / **very slow** error-level logs (`PIPELINE_HOOK_ERROR_LOG_MS`).

## Behavior

| Aspect | Behavior |
|--------|----------|
| Order | `position` ascending (like providers), then `id`; see `PipelineHookSpec` for `schedule` / `mutatesPrimary` |
| Identity | Re-registering the same `id` replaces the handler |
| Errors | Throwing hook: runtime logs and continues |
| Secrets | After all hooks: coerce + `redactSecrets` on `content.text` |
| Streaming | Set `streaming` on the outgoing context so cosmetic hooks can skip |

## `source` values (call sites in core)

| `source` | When |
|----------|------|
| `simple` | Main pipeline: simple reply after final content is ready |
| `action` | `processActions` immediately before each action `callback` |
| `continuation_simple` | Post-action / reflection continuation in simple mode |
| `excluded` | Terminal IGNORE/STOP-style payloads and autonomy STOP |
| `evaluate` | Evaluator-driven callback from the main message handler |
| `autonomy_simple` / `autonomy_evaluate` | `runAutonomyPostResponse` simple path and evaluate callback |

Extensions should pass appropriate `OutgoingContentSource` strings; those strings are part of the `OutgoingContentSource` union for typing and logging.

## Example

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

## Out of scope

- TTS / audio (`HOOK_MESSAGE_SENDING`, voice attachments)
- Rust / Python parity (TS v1)
- Per-room `plain: true` (roadmap)
