# @elizaos/plugin-zai

z.ai model provider plugin for elizaOS — registers `TEXT_SMALL` and `TEXT_LARGE` model handlers backed by z.ai's OpenAI-compatible API.

## Purpose / role

Enables Eliza agents to use z.ai language models (`glm-4.5-air` and `glm-5.1` by default) for text generation. The plugin is auto-enabled when `ZAI_API_KEY` (or the legacy `Z_AI_API_KEY`) is present in the environment. It registers no actions, providers, evaluators, or routes — only model handlers. Supports both Node.js and browser runtimes (browser build uses a proxy base URL instead of the API key directly).

## Plugin surface

No actions, evaluators, providers, or routes are registered.

**Model handlers** (registered on `Plugin.models`):
- `ModelType.TEXT_SMALL` — handled by `handleTextSmall`; uses the `ZAI_SMALL_MODEL` identifier (default `glm-4.5-air`).
- `ModelType.TEXT_LARGE` — handled by `handleTextLarge`; uses the `ZAI_LARGE_MODEL` identifier (default `glm-5.1`).

Both handlers emit `EventType.MODEL_USED` via `emitModelUsageEvent` after each call, carrying prompt/completion/total token counts sourced from the Vercel AI SDK response.

**Auto-enable** (`auto-enable.ts`): elizaOS calls `shouldEnable({ env })` at boot; the plugin self-activates when `ZAI_API_KEY` or `Z_AI_API_KEY` is non-empty. No explicit plugin registration is required when either key is set.

## Layout

```
plugins/plugin-zai/
  index.ts                  Plugin definition (zaiPlugin), config snapshot, test suites
  index.node.ts             Node entrypoint — re-exports index.ts (dist/node/index.node.js)
  index.browser.ts          Browser entrypoint (dist/browser/index.browser.js)
  auto-enable.ts            shouldEnable() — env-only check; no plugin runtime imports
  init.ts                   initializeZai() — validates API key presence at startup
  models/
    index.ts                Re-exports handleTextSmall, handleTextLarge
    text.ts                 Core text generation: resolveTextParams, generateTextWithModel
  providers/
    index.ts                Re-exports createZaiClient, ZaiProvider, ZaiFetch
    openai-compatible.ts    createZaiClient() — builds @ai-sdk/openai-compatible instance
  types/
    index.ts                Branded types: ValidatedApiKey, ModelName, ModelSize, ProviderOptions
  utils/
    config.ts               All setting/env reads: getApiKey, getBaseURL, getSmallModel,
                            getLargeModel, getThinkingConfig, getCoTBudget, etc.
    events.ts               emitModelUsageEvent() — wraps runtime.emitEvent(MODEL_USED, ...)
  __tests__/                Unit tests (vitest)
  build.ts                  Build script (node ESM + browser + CJS via Bun.build; tsc for declarations)
```

## Commands

Only scripts that exist in `package.json`:

```bash
bun run --cwd plugins/plugin-zai build          # compile node + browser outputs to dist/
bun run --cwd plugins/plugin-zai dev            # watch mode build
bun run --cwd plugins/plugin-zai test           # vitest run
bun run --cwd plugins/plugin-zai test:watch     # vitest watch
bun run --cwd plugins/plugin-zai typecheck      # tsgo --noEmit
bun run --cwd plugins/plugin-zai lint           # biome check --write --unsafe
bun run --cwd plugins/plugin-zai lint:check     # biome check (read-only)
bun run --cwd plugins/plugin-zai format         # biome format --write
bun run --cwd plugins/plugin-zai format:check   # biome format (read-only)
bun run --cwd plugins/plugin-zai clean          # rm -rf dist .turbo + tsbuildinfo
```

## Config / env vars

All values are read via `runtime.getSetting(key)` first, then `process.env[key]`.

| Var | Required | Default | Notes |
|---|---|---|---|
| `ZAI_API_KEY` | Yes (Node) | — | Primary API key. Not required in browser builds. |
| `Z_AI_API_KEY` | No | — | Legacy alias; accepted when `ZAI_API_KEY` is absent. |
| `ZAI_BASE_URL` | No | `https://api.z.ai/api/paas/v4` | General API only. `/api/coding/` and `/api/anthropic` paths are actively blocked. |
| `ZAI_BROWSER_BASE_URL` | No | — | Browser-only proxy URL. Replaces `ZAI_BASE_URL` in browser runtime. |
| `ZAI_SMALL_MODEL` | No | `glm-4.5-air` | Model ID for `TEXT_SMALL`. |
| `ZAI_LARGE_MODEL` | No | `glm-5.1` | Model ID for `TEXT_LARGE`. |
| `ZAI_THINKING_TYPE` | No | — | `"enabled"` or `"disabled"`; overrides z.ai's default thinking behavior. |
| `ZAI_COT_BUDGET` | No | — | Deprecated. Positive value enables thinking mode (Anthropic `budget_tokens` is NOT sent). |
| `ZAI_COT_BUDGET_SMALL` | No | — | Deprecated per-size override of `ZAI_COT_BUDGET` for small models. |
| `ZAI_COT_BUDGET_LARGE` | No | — | Deprecated per-size override of `ZAI_COT_BUDGET` for large models. |
| `ZAI_EXPERIMENTAL_TELEMETRY` | No | `false` | Set `"true"` to enable Vercel AI SDK `experimental_telemetry`. |

## How to extend

**Add a model handler** (e.g., `TEXT_EMBEDDING`):
1. Implement the handler in `models/` (create a new file or add to `text.ts`).
2. Export it from `models/index.ts`.
3. Register it in `index.ts` under the `Plugin.models` key using the appropriate `ModelType` constant.

**Add an action or evaluator:**
1. Create the file in a new `actions/` or `evaluators/` subdirectory.
2. Add the object to `Plugin.actions` or `Plugin.evaluators` array in `index.ts`.
3. See root `AGENTS.md` for elizaOS action/evaluator conventions.

**Thinking mode** is injected at the HTTP fetch layer (`createZaiRequestFetch` in `models/text.ts`) rather than via an AI SDK parameter, because z.ai's OpenAI-compatible endpoint expects a `thinking` body field that the SDK does not natively produce. Keep that approach when adding new model types that need thinking support.

## Conventions / gotchas

- **No direct Anthropic `budget_tokens`.** `ZAI_COT_BUDGET*` vars are deprecated shims; they enable `ZAI_THINKING_TYPE=enabled` behavior, but the actual Anthropic field is never forwarded. Use `ZAI_THINKING_TYPE` instead.
- **Base URL validation is strict.** `normalizeDirectApiBaseURL` throws if the URL contains `/api/coding/` or `/api/anthropic`. Do not point this plugin at z.ai Coding Plan endpoints.
- **Browser build omits the API key.** In browsers, use `ZAI_BROWSER_BASE_URL` to route through a proxy that holds the key server-side.
- **`air`/`flash` models cap at 4096 max tokens** by default; all other models cap at 8192. This is hardcoded in `resolveTextParams`.
- **`glm-4.5-air`** is the default small model; **`glm-5.1`** is the default large model. Both can be overridden per-runtime via settings.
- **Per-call model override.** Text handlers honor `params.model` before slot-level model settings. Workflow generation uses this for isolated z.ai tests without changing every z.ai text call.
- `AI_SDK_LOG_WARNINGS` is silenced globally at plugin init to suppress Vercel AI SDK noise; this fires once at startup regardless of whether a key is present.
- For architecture conventions (logger-only logging, ESM module rules, layer boundaries), see the root `AGENTS.md`.

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
