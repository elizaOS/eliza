# @elizaos/plugin-xai

xAI Grok models for text generation and embeddings in elizaOS.

## Purpose / Role

Registers xAI's Grok family as the active model handlers for `TEXT_SMALL`,
`TEXT_LARGE`, and `TEXT_EMBEDDING` within an Eliza agent runtime. It is
**opt-in and auto-enabled** — the elizaOS plugin loader enables it automatically
when `XAI_API_KEY` or `GROK_API_KEY` is present in the environment (via
`auto-enable.ts`). No actions, providers, services, or evaluators are added;
this plugin is purely a model-handler registration. For X (Twitter) social
interactions, use `@elizaos/plugin-x` instead.

## Plugin Surface

This plugin registers **no actions, providers, services, or evaluators**. It
registers three model handlers:

| ModelType          | Handler            | Default model   |
| ------------------ | ------------------ | --------------- |
| `TEXT_SMALL`       | `handleTextSmall`  | `grok-3-mini`   |
| `TEXT_LARGE`       | `handleTextLarge`  | `grok-3`        |
| `TEXT_EMBEDDING`   | `handleTextEmbedding` | `grok-embedding` |

All handlers POST to the xAI OpenAI-compatible REST API (`/chat/completions`,
`/embeddings`). Streaming (`onStreamChunk`) is supported for both text handlers.
Tool-call plumbing (`tools`, `toolChoice`, `responseSchema`, `messages`) is
handled natively via `generateText` in `models/grok.ts`; callers that pass
those fields receive an `XaiNativeTextResult` shape rather than a plain string.
Token usage is emitted via `EventType.MODEL_USED` after every call; if the API
does not return usage data, it is estimated from character count.

## Layout

```
plugins/plugin-xai/
  index.ts              Plugin definition (XAIPlugin export, model handler wiring)
  index.node.ts         Node/Bun entry — re-exports index.ts
  index.browser.ts      Browser entry — re-exports index.ts
  auto-enable.ts        elizaos.plugin.autoEnableModule — lightweight env check
  models/
    grok.ts             All Grok logic: getConfig, generateText, createEmbedding,
                        handleTextSmall, handleTextLarge, handleTextEmbedding,
                        listModels, isGrokConfigured, tool-call normalization
    index.ts            Re-exports grok.ts
  __tests__/
    native-plumbing.shape.test.ts   Unit tests for tool-call normalization shapes
    plugin.live.test.ts             Live API integration test (requires XAI_API_KEY)
  build.ts              Bun.build script (produces node ESM, browser ESM, CJS)
  vitest.config.ts      Vitest config
```

## Commands

All scripts from this plugin's `package.json`:

```bash
bun run --cwd plugins/plugin-xai build        # compile to dist/
bun run --cwd plugins/plugin-xai dev          # watch build (bun --hot)
bun run --cwd plugins/plugin-xai test         # vitest run
bun run --cwd plugins/plugin-xai typecheck    # tsgo --noEmit
bun run --cwd plugins/plugin-xai lint         # biome check
bun run --cwd plugins/plugin-xai format       # biome format --write
bun run --cwd plugins/plugin-xai format:check # biome format (check only)
bun run --cwd plugins/plugin-xai clean        # rm -rf dist .turbo
```

## Config / Env Vars

| Variable              | Required | Default                  | Description                              |
| --------------------- | -------- | ------------------------ | ---------------------------------------- |
| `XAI_API_KEY`         | yes*     | —                        | xAI API key. Checked first.              |
| `GROK_API_KEY`        | yes*     | —                        | Alias accepted by auto-enable; code reads only `XAI_API_KEY` via `getConfig`. |
| `XAI_MODEL`           | no       | `grok-3`                 | Large text model. Also aliased as `XAI_LARGE_MODEL`. |
| `XAI_SMALL_MODEL`     | no       | `grok-3-mini`            | Small text model.                        |
| `XAI_EMBEDDING_MODEL` | no       | `grok-embedding`         | Embedding model.                         |
| `XAI_BASE_URL`        | no       | `https://api.x.ai/v1`   | API base URL (useful for proxies).       |

*At least one of `XAI_API_KEY` / `GROK_API_KEY` triggers auto-enable. The
runtime model handlers require `XAI_API_KEY` specifically (see `getConfig` in
`models/grok.ts`).

Read via `runtime.getSetting(key)` — not `process.env` directly.

## How to Extend

**Add a new model type handler** (e.g. `TEXT_TOKENIZE`):

1. Implement the handler function in `models/grok.ts` following the pattern of
   `handleTextSmall` / `handleTextLarge`.
2. Export it from `models/index.ts`.
3. Register it in the `models` map in `index.ts`:
   ```ts
   [ModelType.TEXT_TOKENIZE]: handleTextTokenize,
   ```
4. Add the corresponding capability string to the `elizaos.plugin.capabilities`
   array in `package.json` if a standard name exists.

**Add a provider or action** — this plugin intentionally has none. If you need
runtime context exposure or conversation-level actions, consider adding a
separate plugin rather than bloating this model-only plugin.

## Conventions / Gotchas

- **`GROK_API_KEY` is auto-enable only.** `getConfig` in `models/grok.ts` only
  reads `XAI_API_KEY`; if a user sets only `GROK_API_KEY` the plugin enables
  but every model call throws. Document this to users.
- **Native vs. string return.** `generateText` returns `XaiNativeTextResult`
  when `messages`, `tools`, `toolChoice`, or `responseSchema` are passed. The
  handler's TypeScript signature says `Promise<string | TextStreamResult>` to
  satisfy the elizaOS `ModelHandler` type, but callers passing those fields
  receive the native shape. Do not widen the return type — the elizaOS plugin
  contract does not support it.
- **Streaming.** Pass `stream: true` and `onStreamChunk` together. The handler
  returns the accumulated `fullText` string, not a stream object.
- **No native SDK dependency.** This plugin calls the xAI REST API directly
  with `fetch` — there is no `openai` or `xai-sdk` npm package involved. This
  keeps the bundle small and browser-compatible.
- **Dual build targets.** The package exports separate `browser` and `node`
  builds (see `exports` in `package.json`). Both resolve to the same `index.ts`
  logic since `fetch` is available in both environments.
- For repo-wide logger rules, naming, and architecture commandments, see the
  root `AGENTS.md`.
