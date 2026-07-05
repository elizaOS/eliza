# @elizaos/plugin-google-genai

Google Generative AI (Gemini) model provider for elizaOS agents.

## Purpose / role

Registers model handlers for all elizaOS `ModelType` tiers (nano through mega, plus embedding, image description, response handler, and action planner) backed by the Google Generative AI (Gemini) API. Loaded via the elizaOS plugin system; auto-enabled whenever `GOOGLE_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, or `GEMINI_API_KEY` is present in the environment. No actions, providers, evaluators, or routes are registered — this plugin's entire surface is model handlers.

## Plugin surface

| Model type | Handler | Default model |
|---|---|---|
| `TEXT_NANO` | `handleTextNano` | falls back to small model |
| `TEXT_SMALL` | `handleTextSmall` | `gemini-2.0-flash-001` |
| `TEXT_MEDIUM` | `handleTextMedium` | falls back to small model |
| `TEXT_LARGE` | `handleTextLarge` | `gemini-2.5-pro-preview-03-25` |
| `TEXT_MEGA` | `handleTextMega` | falls back to large model |
| `RESPONSE_HANDLER` | `handleResponseHandler` | falls back to nano model |
| `ACTION_PLANNER` | `handleActionPlanner` | falls back to medium model |
| `TEXT_EMBEDDING` | `handleTextEmbedding` | `text-embedding-004` (768-dim) |
| `IMAGE_DESCRIPTION` | `handleImageDescription` | `gemini-2.5-pro-preview-03-25` |

Event emitted after each model call: `MODEL_USED` (via `runtime.emitEvent`).

## Layout

```
plugins/plugin-google-genai/
  index.ts                  Plugin object (googleGenAIPlugin), model handler wiring, built-in TestSuites
  index.node.ts             Node/Bun entry (re-exports index.ts)
  index.browser.ts          Browser entry (re-exports index.ts)
  init.ts                   initializeGoogleGenAI() — validates API key at startup
  auto-enable.ts            shouldEnable() — checked by elizaOS auto-enable engine at boot
  models/
    index.ts                Re-exports all handlers
    text.ts                 handleTextSmall/Large/Nano/Medium/Mega/ResponseHandler/ActionPlanner
    embedding.ts            handleTextEmbedding
    image.ts                handleImageDescription
  utils/
    config.ts               getApiKey, createGoogleGenAI, get*Model helpers, getSafetySettings
    events.ts               emitModelUsageEvent (wraps runtime.emitEvent)
    tokenization.ts         countTokens (char-length heuristic, not a real tokenizer)
  types/
    index.ts                Local TS interfaces: TokenUsage, TextGenerationResponse, ImageDescriptionResponse, etc.
  generated/                (generated code — do not hand-edit)
```

## Commands

Scripts that exist in `package.json`:

```bash
bun run --cwd plugins/plugin-google-genai build          # Bun.build (node + browser + CJS bundles, then tsc for declarations)
bun run --cwd plugins/plugin-google-genai dev            # build --watch
bun run --cwd plugins/plugin-google-genai typecheck      # tsgo --noEmit
bun run --cwd plugins/plugin-google-genai test           # vitest run (all tests)
bun run --cwd plugins/plugin-google-genai test:unit      # vitest run --dir __tests__/unit
bun run --cwd plugins/plugin-google-genai test:integration  # vitest run --dir __tests__/integration
bun run --cwd plugins/plugin-google-genai lint           # biome check --write --unsafe
bun run --cwd plugins/plugin-google-genai format         # biome format --write
bun run --cwd plugins/plugin-google-genai clean          # rm -rf dist .turbo .turbo-tsconfig.json tsconfig.tsbuildinfo
```

## Config / env vars

Settings are read first from `runtime.getSetting(key)`, then from `process.env`. All model settings accept both a `GOOGLE_*` prefix (plugin-specific) and a bare generic name (fallback).

| Env var | Required | Default | Notes |
|---|---|---|---|
| `GOOGLE_GENERATIVE_AI_API_KEY` | Yes | — | The only key `getApiKey` reads. `GOOGLE_API_KEY` and `GEMINI_API_KEY` trigger auto-enable (`auto-enable.ts`) but are not read as the API key. |
| `GOOGLE_NANO_MODEL` / `NANO_MODEL` | No | falls back to small | |
| `GOOGLE_SMALL_MODEL` / `SMALL_MODEL` | No | `gemini-2.0-flash-001` | |
| `GOOGLE_MEDIUM_MODEL` / `MEDIUM_MODEL` | No | falls back to small | |
| `GOOGLE_LARGE_MODEL` / `LARGE_MODEL` | No | `gemini-2.5-pro-preview-03-25` | |
| `GOOGLE_MEGA_MODEL` / `MEGA_MODEL` | No | falls back to large | |
| `GOOGLE_RESPONSE_HANDLER_MODEL` / `GOOGLE_SHOULD_RESPOND_MODEL` / `RESPONSE_HANDLER_MODEL` / `SHOULD_RESPOND_MODEL` | No | falls back to nano | |
| `GOOGLE_ACTION_PLANNER_MODEL` / `GOOGLE_PLANNER_MODEL` / `ACTION_PLANNER_MODEL` / `PLANNER_MODEL` | No | falls back to medium | |
| `GOOGLE_IMAGE_MODEL` / `IMAGE_MODEL` | No | `gemini-2.5-pro-preview-03-25` | |
| `GOOGLE_EMBEDDING_MODEL` | No | `text-embedding-004` | 768-dimension output |

## How to extend

### Add a new model handler

1. Add the handler function to `models/text.ts` (or a new file under `models/`) following the pattern of `handleTextWithType`.
2. Export it from `models/index.ts`.
3. Wire it into the `models` map in `index.ts` using the appropriate `ModelType` constant.
4. Add a model-name resolver in `utils/config.ts` (a `get*Model` helper that reads `runtime.getSetting` then `process.env`).
5. Add the new env var keys to the `config` map in the `googleGenAIPlugin` object in `index.ts`.

### Add a test case

Append a `TestCase` object to the `pluginTests[0].tests` array in `index.ts`. Tests run via `runtime.useModel(...)` and assert on the result shape.

## Conventions / gotchas

- **Dual build targets.** `exports.browser` and `exports.node` point to different bundles (`dist/browser/` vs `dist/node/`). The browser build must not import Node-only globals; `utils/config.ts` guards `typeof process` for this reason.
- **Auto-enable module is import-cost sensitive.** `auto-enable.ts` must stay small — no imports of the full plugin runtime. The elizaOS boot loader executes it for every plugin candidate.
- **Structured output.** Pass a JSON Schema as `responseSchema` in `GenerateTextParams`. Text handlers internally set `responseMimeType: "application/json"` and `responseJsonSchema` on the Google SDK request. The model returns raw JSON text; no post-parse step is applied for text handlers (the caller owns parsing).
- **Safety settings are hardcoded.** All four harm categories block at `BLOCK_MEDIUM_AND_ABOVE`. Adjust in `utils/config.ts → getSafetySettings()` if needed.
- **Token counting is a heuristic.** `utils/tokenization.ts` estimates tokens as `Math.ceil(text.length / 4)`. It is used for telemetry only; do not rely on it for context-window management.
- **Embedding truncation.** Inputs longer than ~32 768 characters (~8 192 tokens) are truncated before being sent to the embedding model.
- **No actions, providers, or evaluators.** If you need to add behavior beyond model inference, register it in a separate plugin or in the agent's character definition.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../PR_EVIDENCE.md)**. Read it.
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
