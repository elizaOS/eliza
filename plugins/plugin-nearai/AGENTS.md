# @elizaos/plugin-nearai

NEAR AI Cloud TEE inference provider for Eliza agents via an OpenAI-compatible API.

## Purpose / role

Registers `TEXT_SMALL` and `TEXT_LARGE` model handlers so any Eliza agent can route
text-generation requests through the NEAR AI Cloud inference API
(`https://cloud-api.near.ai/v1` by default). The plugin is **off by default** and
auto-enables when `NEARAI_API_KEY` is present in the environment (`shouldEnable()` in
`auto-enable.ts`, referenced via `elizaos.plugin.autoEnableModule` in `package.json`).
It ships dual builds for both Node.js and browser environments.

## Plugin surface

This plugin registers **no actions, providers, evaluators, or routes**. It registers only
model handlers:

| Model type | Handler | Default model |
|---|---|---|
| `ModelType.TEXT_SMALL` | `handleTextSmall` | `google/gemma-4-31B-it` |
| `ModelType.TEXT_LARGE` | `handleTextLarge` | `google/gemma-4-31B-it` |

Both handlers emit a `EventType.MODEL_USED` event after each successful inference call
(token counts included).

## Layout

```
plugins/plugin-nearai/
  index.ts                  Plugin object (nearaiPlugin), test suites, env bootstrap
  index.node.ts             Node entry point (re-exports index.ts)
  index.browser.ts          Browser entry point (re-exports index.ts)
  auto-enable.ts            shouldEnable() — checks NEARAI_API_KEY; no side effects
  init.ts                   initializeNearAI() — warns if key missing on Node
  models/
    text.ts                 handleTextSmall / handleTextLarge; request normalisation
                            (maps max_completion_tokens→max_tokens, strips store/
                            reasoning_effort/strict, rewrites 'developer' role→'system')
    index.ts                Re-exports from text.ts
  providers/
    openai-compatible.ts    createNearAIClient() — wraps @ai-sdk/openai-compatible
    index.ts                Re-exports from openai-compatible.ts
  types/
    index.ts                Branded types: ValidatedApiKey, ModelName, ProviderOptions
  utils/
    config.ts               All runtime setting / env reads (getApiKey, getBaseURL,
                            getSmallModel, getLargeModel, getExperimentalTelemetry,
                            isBrowser, getRawSetting)
    events.ts               emitModelUsageEvent() helper
```

## Commands

```bash
bun run --cwd plugins/plugin-nearai build         # compile dist/
bun run --cwd plugins/plugin-nearai dev           # watch build
bun run --cwd plugins/plugin-nearai test          # vitest run
bun run --cwd plugins/plugin-nearai test:watch    # vitest watch
bun run --cwd plugins/plugin-nearai lint          # biome check --write --unsafe
bun run --cwd plugins/plugin-nearai typecheck     # tsgo --noEmit -p tsconfig.json
bun run --cwd plugins/plugin-nearai clean         # rm -rf dist .turbo + tsbuildinfo
```

## Config / env vars

All settings are read via `runtime.getSetting(key)` first, then `process.env[key]`.

| Variable | Required | Default | Description |
|---|---|---|---|
| `NEARAI_API_KEY` | Yes (Node) | — | Authentication token for NEAR AI Cloud |
| `NEARAI_BASE_URL` | No | `https://cloud-api.near.ai/v1` | OpenAI-compatible API base URL (Node) |
| `NEARAI_BROWSER_BASE_URL` | No | — | Proxy URL used in browser builds instead of base URL (do not expose API keys in-browser) |
| `NEARAI_SMALL_MODEL` | No | `google/gemma-4-31B-it` | Model identifier for `TEXT_SMALL` |
| `NEARAI_LARGE_MODEL` | No | `google/gemma-4-31B-it` | Model identifier for `TEXT_LARGE` |
| `NEARAI_EXPERIMENTAL_TELEMETRY` | No | `false` | Set `"true"` to enable Vercel AI SDK telemetry |

Model identifiers must match the NEAR AI catalog: `GET https://cloud-api.near.ai/v1/models`.

## How to extend

**Add a new model type** (e.g. `TEXT_EMBEDDING`):

1. Add a handler function in `models/text.ts` following the `generateTextWithModel` pattern.
2. Export it from `models/index.ts`.
3. Register it in the `models` map in `index.ts` under the appropriate `ModelType` key.
4. Add any new config keys to `utils/config.ts` (read via `getRawSetting`) and to `agentConfig.pluginParameters` in `package.json`.
5. Export the new env var from `PluginConfig` in `init.ts` and add it to `plugin.config` in `index.ts`.

**Add a provider option** (e.g. pass `agentName` through):

- `ProviderOptions` in `types/index.ts` is the extension point for nearai-specific request fields.
- `resolveTextParams` in `models/text.ts` reads `params.providerOptions.nearai` and maps to `ProviderOptions`.

## Conventions / gotchas

- **Request normalisation:** The NEAR AI API does not accept `max_completion_tokens`,
  `store`, `reasoning_effort`, or `strict` fields, and does not support the `developer`
  message role. `createNearAIRequestFetch` in `models/text.ts` strips/rewrites these
  before each request. Update it if the upstream API changes.
- **Browser builds:** `isBrowser()` guards all `process.env` access. In browser context,
  `NEARAI_BROWSER_BASE_URL` is used instead of `NEARAI_BASE_URL`; the API key is
  expected to be absent (requests go through a proxy).
- **Auto-enable:** `shouldEnable()` in `auto-enable.ts` is intentionally side-effect-free.
  Do not import the full plugin runtime from it.
- **Branded types:** `ValidatedApiKey` and `ModelName` are nominal string brands (`& { readonly __brand: ... }`). Use `assertValidApiKey` / `createModelName` to construct them — do not cast.
- **Telemetry:** `NEARAI_EXPERIMENTAL_TELEMETRY=true` enables the Vercel AI SDK's
  `experimental_telemetry` option. The `agentName` provider option surfaces in telemetry
  as `functionId` and metadata.
- **elizaOS core version:** peer-depends on `@elizaos/core` via `workspace:*`.

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

Artifacts → `.github/issue-evidence/<issue#>-<slug>.<ext>`; attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — model provider:**
- A trajectory from a **live** call to this provider (not the proxy, not a mock): full request, raw response, token usage, finish reason, and streamed chunks.
- Proof of tool/function-calling and structured-output parsing against the real model.
- The error paths exercised: bad key, model-not-found, oversized context, timeout, rate-limit, mid-stream disconnect — plus latency and cost from the real call.
- If no key is available in CI, attach the documented live-run transcript as evidence — never a mocked client passed off as a pass.
<!-- END: evidence-and-e2e-mandate -->
