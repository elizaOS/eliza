# Recorder fixes — F14 + F16 (2026-05-09)

## Scope

This page documents the fixes for two pre-existing trajectory-recorder bugs flagged in `REPORT.md`:

- **F14** — Anthropic plugin response normalizer dropped `cache_*` fields, so `cacheReadInputTokens` / `cacheCreationInputTokens` were missing from every recorded planner / messageHandler / evaluator stage on Anthropic runs (Opus 4.x and Haiku 4.x).
- **F16** — `model.modelName` was `undefined` on every recorded LLM stage in Anthropic runs, blocking `costUsd` lookup. (The audit also flagged Cerebras here, but Cerebras runs through `plugin-openai`, which already populates `providerMetadata.modelName` via `mergeProviderModelName`. The 19:03 Cerebras trajectory `tj-a81b140a52a55c.json` shows `modelName: gpt-oss-120b` is in fact populated. F16 was an Anthropic-only bug.)

## Root cause

### F14

`plugins/plugin-anthropic/models/text.ts` typed the AI SDK response usage as a hand-rolled `AnthropicUsageWithCache { promptTokens, completionTokens, cacheReadInputTokens, cacheCreationInputTokens }`. That shape predates AI SDK v6. The actual `LanguageModelUsage` returned by `generateText`/`streamText` in `ai@6.x` uses:

- `inputTokens` / `outputTokens` (not `promptTokens` / `completionTokens`)
- `inputTokenDetails.cacheReadTokens` and `inputTokenDetails.cacheWriteTokens` for cache metering
- `providerMetadata.anthropic.cacheCreationInputTokens` for the canonical cache-write count

Because `normalizeAnthropicUsage` only read the legacy field names, it always emitted `usage` without the cache fields. The recorder side (`extractUsage` in `planner-loop.ts`, `extractMessageHandlerUsage` in `services/message.ts`) is correct — it reads `usage.cacheReadInputTokens` / `usage.cacheCreationInputTokens` — but the plugin never populated them.

### F16

`plugins/plugin-anthropic/models/text.ts`'s `buildNativeTextResult` returned `{ text, toolCalls, finishReason, usage }`. It never emitted `providerMetadata`, so when `extractModelName` (planner-loop.ts:1331) looked at `raw.providerMetadata.modelName`, it always read `undefined`. The OpenAI plugin (line 663) already does this correctly via `mergeProviderModelName(result.providerMetadata, modelName)`.

## Code changes

All changes in `plugins/plugin-anthropic/models/text.ts`:

1. **Extended `AnthropicUsageWithCache`** to also carry the AI SDK v6 surface (`inputTokens`, `outputTokens`, `totalTokens`, `cachedInputTokens`, `inputTokenDetails.{noCacheTokens,cacheReadTokens,cacheWriteTokens}`).
2. **Rewrote `normalizeAnthropicUsage(usage, providerMetadata?)`** to:
   - Read `promptTokens` from the legacy `promptTokens` field, falling back to v6 `inputTokens`.
   - Read `completionTokens` from `completionTokens` then `outputTokens`.
   - Read `cacheReadInputTokens` from any of: legacy `cacheReadInputTokens`, v6 `inputTokenDetails.cacheReadTokens`, deprecated `cachedInputTokens`.
   - Read `cacheCreationInputTokens` from any of: legacy `cacheCreationInputTokens`, v6 `inputTokenDetails.cacheWriteTokens`, `providerMetadata.anthropic.cacheCreationInputTokens`.
3. **Extended `NativeGenerateTextResult`** with `providerMetadata?: Record<string, unknown>`.
4. **Updated `buildNativeTextResult(result, modelName?)`** to emit `providerMetadata: mergeProviderModelName(result.providerMetadata, modelName)` (mirrors the OpenAI plugin).
5. **Threaded `modelName` through the call site** at line ~948.
6. **Stream path also reads `providerMetadata`** (Promise) so cache-creation totals reach the usage event when streaming is used.

Test added in `plugins/plugin-anthropic/__tests__/native-plumbing.shape.test.ts`: `"normalizes AI SDK v6 usage shape (inputTokenDetails) into recorder cache fields and emits providerMetadata.modelName"`. Verifies the v6-shape input (with `inputTokens`, `inputTokenDetails`, `providerMetadata.anthropic.cacheCreationInputTokens`) round-trips into the canonical `cacheReadInputTokens` / `cacheCreationInputTokens` on the returned usage, and that `providerMetadata.modelName` is populated.

## Verification

Plugin built (`bun run build`) so the `dist/node/index.node.js` consumed at runtime reflects the source changes.

Live verification: `bun --bun packages/app-core/scripts/lifeops-prompt-benchmark.ts --suite self-care --variant direct` against Anthropic Haiku, run id `lifeops-anthropic-fix-verify-1778379293`. Sample messageHandler stage:

```json
{
  "modelName": "claude-haiku-4-5-20251001",
  "usage": {
    "promptTokens": 5038,
    "completionTokens": 391,
    "totalTokens": 5429,
    "cacheReadInputTokens": 4344,
    "cacheCreationInputTokens": 483
  },
  "costUsd": 0.00256332
}
```

Sample planner stage (cache cold so 0 reads — the field is now present and explicit, not missing):

```json
{
  "modelName": "claude-haiku-4-5-20251001",
  "usage": {
    "promptTokens": 2960,
    "completionTokens": 545,
    "totalTokens": 3505,
    "cacheReadInputTokens": 0,
    "cacheCreationInputTokens": 0
  },
  "costUsd": 0.004548,
  "providerOptionsHasCache": true
}
```

Plugin tests (9/9 pass): `bunx vitest run --config vitest.config.ts __tests__/native-plumbing.shape.test.ts`.

Core typecheck passes: `bun run typecheck` (in `packages/core`).

## Still open

- **F14 follow-up**: planner / evaluator stages on the Anthropic Haiku run report `cacheReadInputTokens: 0` despite having `providerOptions.eliza.{prefixHash, segmentHashes}` set. The fields are now correctly recorded, so the audit can rule out the recorder; the remaining question is whether the planner's segmented user content actually carries `cache_control` on the wire for repeated planner iterations. Cache hits *do* show up on the messageHandler (4344 reads on a 5038-token prompt = 86% hit), so the cache plumbing works in general. Suspect the planner's per-iteration messages include trajectory steps inline (instead of in a stable cached prefix), so each iteration produces a new prefix that misses the cache. Out of scope for this recorder fix.
- **F16 → resolved**. Both Anthropic and Cerebras now record `modelName` and downstream `costUsd` lookup works.
- **Anthropic streaming `TextStreamResult`** does not expose `providerMetadata` to upstream callers (the public interface in `packages/core/src/types/model.ts` defines only `text`, `usage`, `finishReason`, `textStream`). Streaming usage events still emit cache metadata via `emitModelUsageEvent`, but streaming planner / messageHandler stages would not populate `modelName` on the recorder. Today the planner and messageHandler call paths are non-streaming, so this does not regress F16 in practice. If we ever start streaming planner output, extending `TextStreamResult` (and the runtime's stream-end branch in `runtime.ts:4343`) to expose `providerMetadata` becomes necessary.
