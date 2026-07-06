# @elizaos/plugin-openrouter

OpenRouter multi-model AI gateway plugin for elizaOS.

## Purpose / role

Provides text generation, image description, image generation, and text embedding capabilities to any Eliza agent by routing requests through the [OpenRouter](https://openrouter.ai) API. The plugin registers model handlers — no actions, providers, services, or evaluators. It auto-enables when `OPENROUTER_API_KEY` is present in the environment (see `auto-enable.ts` and the `elizaos.plugin.autoEnableModule` field in `package.json`). Ships dual builds: `node` (default) and `browser` (no Authorization header; use `OPENROUTER_BROWSER_BASE_URL` proxy instead).

## Plugin surface

No actions, services, evaluators, providers, or routes. This plugin registers **model handlers only**:

| `ModelType` | Handler | Default model |
|---|---|---|
| `TEXT_NANO` | `handleTextNano` | falls back to small model |
| `TEXT_SMALL` | `handleTextSmall` | `google/gemini-2.5-flash-lite` |
| `TEXT_MEDIUM` | `handleTextMedium` | falls back to small model |
| `TEXT_LARGE` | `handleTextLarge` | `google/gemini-2.5-flash` |
| `TEXT_MEGA` | `handleTextMega` | falls back to large model |
| `RESPONSE_HANDLER` | `handleResponseHandler` | falls back to nano model |
| `ACTION_PLANNER` | `handleActionPlanner` | falls back to medium model |
| `IMAGE_DESCRIPTION` | `handleImageDescription` | `x-ai/grok-2-vision-1212` |
| `IMAGE` | `handleImageGeneration` | `google/gemini-2.5-flash-image-preview` |
| `TEXT_EMBEDDING` | `handleTextEmbedding` | `openai/text-embedding-3-small` (1536 dims) |
| `TRANSCRIPTION` | `handleTranscription` | `openai/whisper-large-v3` |

All text handlers support streaming (`params.stream = true`), `tools`/`toolChoice`, and `responseSchema` for structured JSON output. Sampling parameters (temperature, frequencyPenalty, presencePenalty) are suppressed for `openai/*`, `anthropic/*`, and reasoning models (o1/o3/o4, gpt-5, gpt-5-mini) to avoid API errors. Every handler emits a `MODEL_USED` event via `utils/events.ts` after each call.

## Layout

```
plugins/plugin-openrouter/
  index.ts                  Public exports: re-exports plugin + types + config helpers
  plugin.ts                 Plugin object definition (model registrations, config, tests)
  init.ts                   initializeOpenRouter() — validates API key at boot (node only)
  auto-enable.ts            shouldEnable() — checked by elizaOS plugin loader at boot
  models/
    audio.ts                TRANSCRIPTION handler (direct fetch to /audio/transcriptions)
    text.ts                 All text model handlers (nano/small/medium/large/mega/response-handler/action-planner)
    image.ts                IMAGE_DESCRIPTION and IMAGE generation handlers
    embedding.ts            TEXT_EMBEDDING handler (direct fetch to /embeddings endpoint)
  providers/
    openrouter.ts           createOpenRouterProvider() — wraps @openrouter/ai-sdk-provider
    index.ts                Re-export
  utils/
    config.ts               getApiKey, getBaseURL, get*Model, getEmbeddingDimensions, shouldAutoCleanupImages
    events.ts               emitModelUsageEvent() — emits EventType.MODEL_USED with token counts
    helpers.ts              Shared utilities
    index.ts                Re-export
  types/
    index.ts                Plugin-local TypeScript interfaces (OpenRouterConfig, TextGenerationParams, etc.)
  __tests__/                Unit + live integration tests
  build.ts                  Bun build script (node ESM + browser ESM + CJS outputs)
```

## Commands

```bash
bun run --cwd plugins/plugin-openrouter build          # bun build.ts (node ESM + browser ESM + CJS)
bun run --cwd plugins/plugin-openrouter dev            # hot-rebuild watch mode
bun run --cwd plugins/plugin-openrouter test           # vitest unit suite
bun run --cwd plugins/plugin-openrouter test:unit      # __tests__/ only
bun run --cwd plugins/plugin-openrouter test:watch     # vitest watch
bun run --cwd plugins/plugin-openrouter typecheck      # tsc --noEmit
bun run --cwd plugins/plugin-openrouter lint           # biome check --write --unsafe
bun run --cwd plugins/plugin-openrouter format         # biome format --write
bun run --cwd plugins/plugin-openrouter clean          # rm dist .turbo tsconfig.tsbuildinfo
```

Live integration tests (require real API key) use `vitest.live.config.ts` — not run in CI.

## Config / env vars

Settings are read via `runtime.getSetting(key)` first, then `process.env[key]`. Plugin-specific vars take priority over generic fallbacks.

| Env var | Required | Default | Description |
|---|---|---|---|
| `OPENROUTER_API_KEY` | **yes** | — | OpenRouter API key. Auto-enable gating key. |
| `OPENROUTER_BASE_URL` | no | `https://openrouter.ai/api/v1` | API endpoint override. |
| `OPENROUTER_BROWSER_BASE_URL` | no | — | Proxy URL used in browser builds (no API key in client). |
| `OPENROUTER_SMALL_MODEL` | no | `google/gemini-2.5-flash-lite` | Override for TEXT_SMALL/TEXT_NANO/TEXT_MEDIUM base. |
| `OPENROUTER_LARGE_MODEL` | no | `google/gemini-2.5-flash` | Override for TEXT_LARGE/TEXT_MEGA base. |
| `OPENROUTER_NANO_MODEL` | no | — | Override for TEXT_NANO specifically. |
| `OPENROUTER_MEDIUM_MODEL` | no | — | Override for TEXT_MEDIUM specifically. |
| `OPENROUTER_MEGA_MODEL` | no | — | Override for TEXT_MEGA specifically. |
| `OPENROUTER_RESPONSE_HANDLER_MODEL` | no | — | Override for RESPONSE_HANDLER; also checks `OPENROUTER_SHOULD_RESPOND_MODEL`. |
| `OPENROUTER_ACTION_PLANNER_MODEL` | no | — | Override for ACTION_PLANNER; also checks `OPENROUTER_PLANNER_MODEL`. |
| `OPENROUTER_IMAGE_MODEL` | no | `x-ai/grok-2-vision-1212` | Override for IMAGE_DESCRIPTION. |
| `OPENROUTER_IMAGE_GENERATION_MODEL` | no | `google/gemini-2.5-flash-image-preview` | Override for IMAGE generation. |
| `OPENROUTER_EMBEDDING_MODEL` | no | `openai/text-embedding-3-small` | Override for TEXT_EMBEDDING. |
| `OPENROUTER_TRANSCRIPTION_MODEL` | no | `openai/whisper-large-v3` | Override for TRANSCRIPTION. |
| `OPENROUTER_EMBEDDING_DIMENSIONS` | no | `1536` | Embedding vector size. Valid: 256, 384, 512, 768, 1024, 1536, 2048, 3072. |
| `OPENROUTER_AUTO_CLEANUP_IMAGES` | no | `false` | Flag read by `shouldAutoCleanupImages()` in `utils/config.ts`. |
| `SMALL_MODEL`, `LARGE_MODEL`, etc. | no | — | Generic fallbacks when OPENROUTER_* variants are unset. |

`OPENROUTER_HTTP_REFERER` and `OPENROUTER_X_TITLE` are read in `embedding.ts` for the embeddings request headers.

## How to extend

**Add a new model handler type:**
1. Add a handler function in the appropriate `models/*.ts` file following the pattern of existing handlers (call `generateTextWithModel` with the new `ModelType`).
2. Register it in `plugin.ts` under `models: { [ModelType.NEW_TYPE]: async (runtime, params) => ... }`.
3. If the type needs a configurable model name, add `getNewTypeModel()` to `utils/config.ts` following the priority pattern: `OPENROUTER_*` first, generic fallback second, hard default third.

**Add a config helper:**
- Add to `utils/config.ts`. Follow the `getSetting(runtime, "OPENROUTER_X") ?? getSetting(runtime, "X", default)` pattern so agent character settings override env vars.

**Add a test:**
- Unit tests go in `__tests__/`. Live integration tests (real API) go in `__tests__/*.live.test.ts` and use `vitest.live.config.ts`.

## Conventions / gotchas

- **Sampling param suppression:** `models/text.ts:supportsSamplingParameters()` skips temperature/frequencyPenalty/presencePenalty for `openai/*`, `anthropic/*`, and reasoning models. Extend the constant arrays at the top of that file if new no-sampling models are added.
- **Browser build:** The browser export omits the API key from the `Authorization` header. Set `OPENROUTER_BROWSER_BASE_URL` to a server-side proxy that injects the key. The `init.ts` API key validation is also skipped in browser environments.
- **Embedding dimension validation:** The embedding handler validates the configured dimension against `VECTOR_DIMS` from `@elizaos/core`. Mismatches throw immediately — no silent truncation.
- **Embedding input truncation:** Inputs over ~32 000 characters (~8 000 tokens) are truncated with a warning rather than failing.
- **Structured output:** Pass `responseSchema` (JSON Schema object) to any text handler to get parsed JSON back. The handler wraps it into the AI SDK `output` field and calls `JSON.parse` on the response.
- **Prompt caching:** Pass `providerOptions: { openrouter: { promptCacheKey: "<key>" } }` to text handlers; it is forwarded to OpenRouter's `prompt_cache_key` for prefix caching on supported backends.
- **Audio transcription:** `ModelType.TRANSCRIPTION` posts base64 audio to OpenRouter's `/audio/transcriptions` endpoint. Supported inputs are URL strings, `Buffer`, `Blob` / `File`, core `{ audioUrl, prompt? }`, and local `{ audio, model?, language?, temperature?, format?, mimeType? }` objects.
- **`@openrouter/ai-sdk-provider` + `ai` SDK:** The plugin wraps `@openrouter/ai-sdk-provider ^2.0.0` and uses `ai ^6.0.30`. Both are runtime dependencies, not peer deps.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../AGENTS.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — model provider:**
- A trajectory from a **live** call to this provider (not the proxy, not a mock): full request, raw response, token usage, finish reason, and streamed chunks.
- Proof of tool/function-calling and structured-output parsing against the real model.
- The error paths exercised: bad key, model-not-found, oversized context, timeout, rate-limit, mid-stream disconnect — plus latency and cost from the real call.
- If no key is available in CI, attach the documented live-run transcript as evidence — never a mocked client passed off as a pass.
<!-- END: evidence-and-e2e-mandate -->
