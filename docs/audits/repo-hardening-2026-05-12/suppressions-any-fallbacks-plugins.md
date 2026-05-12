# Suppressions, `any`, and Fallback Hardening Audit: Plugin/App Packages

Date: 2026-05-12

Scope:

- Primary packages: `plugins/app-lifeops`, `plugins/plugin-health`, `plugins/plugin-wallet`, `plugins/plugin-local-ai`, `plugins/plugin-discord`, `plugins/plugin-openai`, `plugins/plugin-anthropic`, `plugins/plugin-elizacloud`, `plugins/plugin-workflow`, `plugins/plugin-agent-orchestrator`, `plugins/plugin-sql`, `plugins/app-training`, `plugins/app-companion`, `plugins/app-task-coordinator`, `plugins/app-wallet`.
- Additional plugin/app packages with material signal: `plugins/app-steward`, `plugins/plugin-music`, `plugins/plugin-social-alpha`.
- Excluded: `node_modules`, `dist`, `build`, `coverage`, `docs/audits`, and declaration files.
- Report only. No implementation edits were made.

LifeOps/Health invariants preserved in this audit:

- LifeOps must keep one task primitive: `ScheduledTask`.
- LifeOps behavior must stay structural: decisions belong on `kind`, `trigger`, `shouldFire`, `completionCheck`, `pipeline`, `output`, `subject`, `priority`, and `respectsGlobalPause`, not `promptInstructions`.
- Health remains separate and contributes through registries/connectors/anchors/default packs. LifeOps should not import health internals.

## Executive summary

The highest-risk hardening work is concentrated in three areas:

1. **Production `@ts-nocheck` islands** in `app-lifeops`, `plugin-wallet`, and `plugin-local-ai`. These suppress whole-file type checking in modules that touch scheduling, task mutation, wallet/DeFi actions, local model initialization, audio, vision, and generated tool-call handling.
2. **Fallbacks that turn failures into empty data or implicit success** in workflow dispatch, wallet analytics, app-wallet inventory, agent-orchestrator memory/context routes, and training budget/checkpoint paths.
3. **Boundary typing is mixed with internal typing**. `unknown` is often acceptable at JSON/runtime/plugin boundaries, but several places immediately cast to broad `Record<string, unknown>` or `any` without a package-level parser contract.

The report classifies findings as:

- **must-fix**: production suppression or fallback can hide broken behavior, security/credential failures, data loss, or contract drift.
- **acceptable boundary**: the pattern is justified at a generated file, external library, UI compatibility, test-only malformed input, ANSI regex, or JSON ingress boundary, provided the boundary stays local and validation follows immediately.

## Raw counts

Counts are broad lexical matches, not all defects. Optional chaining and fallback operators are common in UI and parsers; the material findings below are the subset judged likely to hide bugs.

| Package | Files scanned | Suppressions | `@ts-nocheck` | `@ts-ignore`/`@ts-expect-error` | Lint suppressions | `any` | `unknown` | Non-null `!` | `?.` | `??` | `||` | try/catch |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `plugins/app-lifeops` | 584 | 30 | 28 | 0 | 2 | 158 | 1902 | 48 | 3102 | 3802 | 2270 | 1121 |
| `plugins/plugin-health` | 43 | 0 | 0 | 0 | 0 | 16 | 148 | 0 | 43 | 140 | 110 | 4 |
| `plugins/plugin-wallet` | 210 | 86 | 83 | 1 | 2 | 54 | 340 | 13 | 549 | 479 | 741 | 720 |
| `plugins/plugin-local-ai` | 19 | 8 | 8 | 0 | 0 | 1 | 10 | 10 | 65 | 17 | 43 | 124 |
| `plugins/plugin-discord` | 70 | 2 | 0 | 0 | 2 | 13 | 250 | 1 | 598 | 431 | 379 | 412 |
| `plugins/plugin-openai` | 31 | 0 | 0 | 0 | 0 | 3 | 81 | 0 | 52 | 161 | 48 | 15 |
| `plugins/plugin-anthropic` | 25 | 0 | 0 | 0 | 0 | 4 | 78 | 3 | 52 | 112 | 65 | 40 |
| `plugins/plugin-elizacloud` | 82 | 1 | 0 | 0 | 1 | 12 | 830 | 3 | 210 | 319 | 168 | 196 |
| `plugins/plugin-workflow` | 77 | 2 | 0 | 2 | 0 | 17 | 324 | 0 | 318 | 168 | 145 | 123 |
| `plugins/plugin-agent-orchestrator` | 118 | 8 | 0 | 0 | 8 | 54 | 636 | 6 | 818 | 801 | 569 | 510 |
| `plugins/plugin-sql` | 161 | 0 | 0 | 0 | 0 | 32 | 343 | 27 | 216 | 237 | 383 | 330 |
| `plugins/app-training` | 84 | 0 | 0 | 0 | 0 | 25 | 361 | 10 | 326 | 546 | 303 | 127 |
| `plugins/app-companion` | 64 | 2 | 0 | 0 | 2 | 4 | 32 | 0 | 205 | 140 | 226 | 84 |
| `plugins/app-task-coordinator` | 27 | 4 | 0 | 0 | 4 | 4 | 74 | 0 | 85 | 68 | 72 | 65 |
| `plugins/app-wallet` | 16 | 0 | 0 | 0 | 0 | 3 | 5 | 0 | 62 | 46 | 55 | 20 |

Additional packages with material signal:

| Package | Files scanned | Suppressions | `@ts-nocheck` | `any` | try/catch | Notes |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `plugins/app-steward` | 54 | 0 | 0 | 3 | 297 | Many defensive runtime catches; audit after primary packages. |
| `plugins/plugin-music` | 80 | 0 | 0 | 27 | 320 | External media/API boundary; audit fallback-to-empty behavior. |
| `plugins/plugin-social-alpha` | 41 | 3 | 0 | 100 | 165 | SQLite and zod boundary suppressions plus broad `any`. |

## Cross-package hardening patterns

Use these fix patterns consistently:

- Replace whole-file `@ts-nocheck` with small typed adapters at the external boundary. Add local interfaces and assertion helpers, then remove suppression per file.
- For JSON and SDK boundaries, parse into a named result type with a guard, e.g. `parseFooResponse(raw): FooResponse | FooParseError`. Do not cast through `Record<string, unknown>` and continue.
- Split expected absence from failure. Return `null` or `[]` only for a documented not-found/disabled state; throw or return a typed error for parse, credential, network, persistence, and dispatch failures.
- Replace `||` with `??` when `0`, `false`, or `""` are valid domain values. For financial and token fields, preserve actual zero and track unknown separately.
- Make browser/client secret fallbacks explicit. In browser mode, proxy-only should be validated as such; empty auth headers should not silently become unauthenticated provider calls unless the API is intentionally public.
- Convert catch-and-warn paths into result unions where the caller can show degraded/unavailable state.

## Per-package findings

### `plugins/app-lifeops`

Classification: **must-fix for production `@ts-nocheck`; acceptable boundary for many `unknown` JSON/API normalizers.**

Material findings:

- **must-fix:** Whole-file `@ts-nocheck` covers most service mixins that define LifeOps' public behavior surface:
  `plugins/app-lifeops/src/lifeops/service-mixin-workflows.ts:1`,
  `plugins/app-lifeops/src/lifeops/service-mixin-x.ts:1`,
  `plugins/app-lifeops/src/lifeops/service-mixin-discord.ts:1`,
  `plugins/app-lifeops/src/lifeops/service-mixin-reminders.ts:1`,
  `plugins/app-lifeops/src/lifeops/service-mixin-drive.ts:1`,
  `plugins/app-lifeops/src/lifeops/service-mixin-calendar.ts:1`,
  `plugins/app-lifeops/src/lifeops/service-mixin-relationships.ts:1`,
  `plugins/app-lifeops/src/lifeops/service-mixin-status.ts:1`,
  `plugins/app-lifeops/src/lifeops/service-mixin-email-unsubscribe.ts:1`,
  `plugins/app-lifeops/src/lifeops/service-mixin-scheduling.ts:1`,
  `plugins/app-lifeops/src/lifeops/service-mixin-inbox.ts:1`,
  `plugins/app-lifeops/src/lifeops/service-mixin-subscriptions.ts:1`,
  `plugins/app-lifeops/src/lifeops/service-mixin-health.ts:1`,
  `plugins/app-lifeops/src/lifeops/service-mixin-sleep.ts:1`,
  `plugins/app-lifeops/src/lifeops/service-mixin-gmail.ts:1`,
  `plugins/app-lifeops/src/lifeops/service-mixin-travel.ts:1`,
  `plugins/app-lifeops/src/lifeops/service-mixin-imessage.ts:1`,
  `plugins/app-lifeops/src/lifeops/service-mixin-screentime.ts:1`,
  `plugins/app-lifeops/src/lifeops/service-mixin-payments.ts:1`,
  `plugins/app-lifeops/src/lifeops/service-mixin-goals.ts:1`,
  `plugins/app-lifeops/src/lifeops/service-mixin-telegram.ts:1`,
  `plugins/app-lifeops/src/lifeops/service-mixin-browser.ts:1`,
  `plugins/app-lifeops/src/lifeops/service-mixin-definitions.ts:1`,
  `plugins/app-lifeops/src/lifeops/service-mixin-signal.ts:1`,
  `plugins/app-lifeops/src/lifeops/service-mixin-x-read.ts:1`,
  `plugins/app-lifeops/src/lifeops/service-mixin-google.ts:1`,
  `plugins/app-lifeops/src/lifeops/service-mixin-whatsapp.ts:1`.
  Suggested fix pattern: keep the one `ScheduledTask` primitive and current structural behavior, but introduce typed mixin contracts per domain (`LifeOpsSchedulingMixinApi`, `LifeOpsConnectorMixinApi`, etc.) and make each `withFoo<TBase>()` return `MixinClass<TBase, FooApi>`. Validate incrementally by removing `@ts-nocheck` from one mixin at a time.
  Validation needed: `bun test plugins/app-lifeops/test`, `bun run lint:default-packs`, scheduling runner tests, connector status/action tests.

- **must-fix:** `plugins/app-lifeops/src/lifeops/service-mixin-runtime-delegation.test.ts:1` uses `@ts-nocheck` in a test that should protect the mixin delegation contract. Suggested fix pattern: replace loose fixture objects with `Partial<LifeOpsService>`/`satisfies` helpers and explicit casts only at fake runtime boundaries.
  Validation needed: targeted `service-mixin-runtime-delegation` test.

- **acceptable boundary with guardrails:** `plugins/app-lifeops/src/lifeops/service-mixin-core.ts:59` suppresses `noExplicitAny` for the mixin constructor type at `plugins/app-lifeops/src/lifeops/service-mixin-core.ts:60`. This is a known TypeScript mixin boundary, but it should remain the only `any` required by the pattern. Suggested fix pattern: use `abstract new (...args: never[])` if possible, or define `AnyConstructor` once and ban local constructor `any` elsewhere.
  Validation needed: typecheck after removing `@ts-nocheck` from at least two mixins.

- **must-fix:** `plugins/app-lifeops/src/lifeops/service-normalize-task.ts:61`, `plugins/app-lifeops/src/lifeops/service-normalize-task.ts:85`, and `plugins/app-lifeops/src/lifeops/service-normalize-task.ts:101` validate only outer object shape before casting cadence/window/website policies into domain types. This can admit malformed task definitions into `ScheduledTask` normalization.
  Suggested fix pattern: add structural normalizers for `LifeOpsCadence`, `LifeOpsWindowPolicy`, `LifeOpsProgressionRule`, `LifeOpsWebsiteAccessPolicy`, and any task output/pipeline subcontracts; reject invalid input at request boundary.
  Validation needed: malformed task creation tests that verify 400s and no task persistence.

- **acceptable boundary:** `plugins/app-lifeops/src/lifeops/runtime.ts:97` catches failure to load app state and returns `false` at `plugins/app-lifeops/src/lifeops/runtime.ts:106`, skipping scheduler ticks when toggle state is unknown. This is fail-closed. Keep it, but emit structured state so health checks can distinguish "paused by user" from "state unavailable".
  Validation needed: scheduler worker telemetry or status endpoint test.

- **acceptable boundary:** `plugins/app-lifeops/src/lifeops/scheduled-task/scheduler.ts:147`, `plugins/app-lifeops/src/lifeops/scheduled-task/scheduler.ts:179`, and `plugins/app-lifeops/src/lifeops/scheduled-task/scheduler.ts:266` catch per-task failures, record `result.errors`, and continue. This preserves one runner and avoids one bad task blocking all tasks. Keep the structure, but ensure callers surface `result.errors`.
  Validation needed: scheduler API/runner tests assert error entries are visible to the operator.

- **acceptable boundary:** `plugins/app-lifeops/src/lifeops/scheduled-task/runner.ts:1038` catches channel dispatch and returns `dispatch_failed` at `plugins/app-lifeops/src/lifeops/scheduled-task/runner.ts:1051`. This is structural and appropriate; downstream must persist/log the failure state.
  Validation needed: dispatch failure lifecycle test verifies persisted state/log.

- **must-fix under LifeOps/Health invariant:** `plugins/app-lifeops/src/lifeops/service-mixin-health.ts:130` reads health connector config from process env and lives under a `@ts-nocheck` mixin. The bridge can remain in LifeOps only as a registry-facing adapter; do not import plugin-health internals. Suggested fix pattern: define a typed health connector registry interface in shared contract/stubs and validate provider/capability/date inputs as already started at `plugins/app-lifeops/src/lifeops/service-mixin-health.ts:145`, `plugins/app-lifeops/src/lifeops/service-mixin-health.ts:161`, and `plugins/app-lifeops/src/lifeops/service-mixin-health.ts:186`.
  Validation needed: LifeOps health endpoint tests with plugin-health absent/present.

### `plugins/plugin-health`

Classification: **acceptable boundary.**

Material findings:

- No suppressions. `unknown` is primarily in default pack contract stubs and registry-shaped interfaces, e.g. `plugins/plugin-health/src/default-packs/contract-stubs.ts:65`, `plugins/plugin-health/src/default-packs/contract-stubs.ts:71`, `plugins/plugin-health/src/default-packs/contract-stubs.ts:128`, and `plugins/plugin-health/src/default-packs/contract-stubs.ts:154`.
  Suggested fix pattern: keep plugin-health as a registry contributor; do not couple to LifeOps internals. Consider promoting shared contract types once LifeOps removes mixin `@ts-nocheck`.
  Validation needed: default pack lint and registry registration tests.

### `plugins/plugin-wallet`

Classification: **must-fix for production `@ts-nocheck` and financial fallbacks; acceptable boundary for browser shim template if generated/isolated.**

Material findings:

- **must-fix:** 83 `@ts-nocheck` files cover wallet analytics, token info, LP services, EVM/Solana DEX modules, and type files. Examples:
  `plugins/plugin-wallet/src/analytics/birdeye/service.ts:1`,
  `plugins/plugin-wallet/src/analytics/token-info/providers.ts:1`,
  `plugins/plugin-wallet/src/lp/actions/liquidity.ts:1`,
  `plugins/plugin-wallet/src/lp/services/LpManagementService.ts:1`,
  `plugins/plugin-wallet/src/lp/services/ConcentratedLiquidityService.ts:1`,
  `plugins/plugin-wallet/src/chains/evm/dex/uniswap/services/UniswapV3LpService.ts:1`,
  `plugins/plugin-wallet/src/chains/solana/dex/meteora/services/MeteoraLpService.ts:1`,
  `plugins/plugin-wallet/src/chains/solana/dex/raydium/services/srv_raydium.ts:1`,
  `plugins/plugin-wallet/src/chains/solana/dex/orca/services/srv_orca.ts:1`.
  Suggested fix pattern: start with API/client boundary types (`Birdeye`, `DexScreener`, `Kamino`, `Meteora`, `Orca`, `Raydium`), then migrate service methods to typed result unions. Keep approvals/signing contracts typed and isolated from legacy analytics.
  Validation needed: wallet unit tests, live API tests gated by env, and canonical sign/approval tests.

- **must-fix:** Financial/token fallbacks use `|| 0` and `|| ""` in data mapping at `plugins/plugin-wallet/src/analytics/birdeye/service.ts:271` through `plugins/plugin-wallet/src/analytics/birdeye/service.ts:280`. This hides missing fields, NaN-like values, and real zero semantics.
  Suggested fix pattern: use `??` for nullable fields, validate numeric fields with `Number.isFinite`, and represent unknown market data as `null` rather than zero.
  Validation needed: token mapping tests covering missing liquidity, zero liquidity, missing price, and zero price.

- **must-fix:** `plugins/plugin-wallet/src/analytics/birdeye/service.ts:242` uses `Promise.allSettled`, then `plugins/plugin-wallet/src/analytics/birdeye/service.ts:286` through `plugins/plugin-wallet/src/analytics/birdeye/service.ts:290` silently drops failed fetches. For market/trending data this can present partial data as complete.
  Suggested fix pattern: return `{ data, partial: true, errors }` or fail the request if all offsets fail; expose provider degradation to UI.
  Validation needed: test with one failed offset and all failed offsets.

- **acceptable boundary:** `plugins/plugin-wallet/src/analytics/birdeye/service.ts:301` catches cache write errors and continues at `plugins/plugin-wallet/src/analytics/birdeye/service.ts:303` through `plugins/plugin-wallet/src/analytics/birdeye/service.ts:309`. This is acceptable for cache-aside, but should log structured package/provider/cache key.
  Validation needed: cache failure test still returns fetched data and emits warning.

- **acceptable boundary:** `plugins/plugin-wallet/src/browser-shim/shim.template.js:1` and `plugins/plugin-wallet/src/browser-shim/shim.template.js:2` suppress lint in an injected browser template. Keep isolated. It must not import package internals and should be generated/tested as a string.
  Validation needed: shim build test and minimal dApp injection smoke.

- **must-fix:** `plugins/plugin-wallet/src/chains/solana/dex/meteora/utils/dlmm.ts:1` combines file-wide `@ts-nocheck` with a local `@ts-expect-error` at `plugins/plugin-wallet/src/chains/solana/dex/meteora/utils/dlmm.ts:8`. One of these is redundant and the export compatibility should be handled with a typed module adapter.
  Suggested fix pattern: type `DLMMDefault` as `{ default?: typeof import("@meteora-ag/dlmm") }` or add a small declaration shim.
  Validation needed: bundler test for ESM/CJS default export shapes.

### `plugins/plugin-local-ai`

Classification: **must-fix.**

Material findings:

- **must-fix:** `@ts-nocheck` covers the plugin entry and core managers:
  `plugins/plugin-local-ai/index.ts:1`,
  `plugins/plugin-local-ai/structured-output.ts:1`,
  `plugins/plugin-local-ai/environment.ts:1`,
  `plugins/plugin-local-ai/utils/tokenizerManager.ts:1`,
  `plugins/plugin-local-ai/utils/visionManager.ts:1`,
  `plugins/plugin-local-ai/utils/ttsManager.ts:1`,
  `plugins/plugin-local-ai/utils/transcribeManager.ts:1`,
  `plugins/plugin-local-ai/utils/platform.ts:1`.
  These files include model paths, singleton initialization, tool calls, tokenizers, ffmpeg, TTS, and vision.
  Suggested fix pattern: introduce local facade types for `@huggingface/transformers` and node-llama-cpp deltas instead of disabling the whole plugin. Migrate `environment.ts` and `structured-output.ts` first because they are small boundary modules.
  Validation needed: local-ai smoke tests, tokenizer encode/decode, embeddings, vision, transcription, and TTS tests where dependencies are available.

- **must-fix:** Definite assignment assertions at `plugins/plugin-local-ai/index.ts:219` through `plugins/plugin-local-ai/index.ts:229` and `plugins/plugin-local-ai/index.ts:248` depend on initialization order. Several methods read these fields after async lazy initialization.
  Suggested fix pattern: model state as a discriminated union (`uninitialized`/`ready`) or make each accessor call `assertEnvironmentReady()` returning a typed ready object.
  Validation needed: call model methods before `init` and during concurrent init.

- **must-fix:** `plugins/plugin-local-ai/index.ts:270` and `plugins/plugin-local-ai/index.ts:291` use `||` to choose env/config directories. Empty strings currently fall back to process/default silently. That may be acceptable for unset env, but should be explicit because paths are operational config.
  Suggested fix pattern: normalize config strings once with `trimmedNonEmpty(value)` and return a configuration error for explicitly empty settings if configured through runtime.
  Validation needed: empty `MODELS_DIR`/`CACHE_DIR` config test.

- **must-fix:** `plugins/plugin-local-ai/index.ts:597` through `plugins/plugin-local-ai/index.ts:604` falls back to an empty repeat-penalty token list when `punishModel` is missing. That hides lazy model initialization drift and changes generation behavior.
  Suggested fix pattern: assert the selected model exists before generation options are built, or disable repeat penalty with an explicit logged mode.
  Validation needed: generation test with missing small/medium model fails clearly.

- **acceptable boundary but should be documented:** `plugins/plugin-local-ai/utils/visionManager.ts:73` treats any `CUDA_VISIBLE_DEVICES` value, including empty string, as CUDA enabled.
  Suggested fix pattern: normalize CUDA env (`undefined`, empty, `-1`) explicitly.
  Validation needed: platform detection tests.

### `plugins/plugin-discord`

Classification: **mostly acceptable boundary; one must-fix `any`.**

Material findings:

- **must-fix:** `plugins/plugin-discord/service.ts:2404` uses `readyClient: any` for `onReadyForAccount`, a core lifecycle path. Suggested fix pattern: use `DiscordJsClient` or the narrowed ready-client interface already used by `refreshOwnerDiscordUserIds`.
  Validation needed: Discord service typecheck and ready handler tests.

- **acceptable boundary:** `plugins/plugin-discord/service.ts:476` through `plugins/plugin-discord/service.ts:493` catches Discord application fetch failure, falls back to `client.application`, and logs owner recognition will be unavailable. This is acceptable only because it is fail-closed for owner/admin recognition.
  Suggested fix pattern: expose this degraded state in service status so operators can see owner mapping is not active.
  Validation needed: service status test when application fetch rejects.

- **acceptable boundary:** ANSI regex suppressions in `plugins/plugin-discord/banner.ts:76` and `plugins/plugin-discord/banner.ts:109` are narrow and justified for terminal formatting.
  Validation needed: none beyond lint.

### `plugins/plugin-openai`

Classification: **must-fix for model default drift and empty auth fallback; boundary `unknown` is acceptable.**

Material findings:

- **must-fix:** `plugins/plugin-openai/utils/config.ts:117` through `plugins/plugin-openai/utils/config.ts:129` returns `{}` when no API key is available or browser mode blocks secrets. That is safe for browser secret exposure, but unsafe if server-side callers proceed to OpenAI with unauthenticated requests and later report provider errors.
  Suggested fix pattern: split `getAuthHeader` into `getRequiredAuthHeader` for provider calls and `getOptionalAuthHeader` for explicitly public/proxy calls.
  Validation needed: model call without `OPENAI_API_KEY` fails before fetch with a configuration error; browser proxy calls still omit secrets.

- **must-fix:** Static defaults in `plugins/plugin-openai/utils/config.ts:156` through `plugins/plugin-openai/utils/config.ts:238` can hide missing model settings and stale model names. The current defaults include text, embedding, image, transcription, and TTS models.
  Suggested fix pattern: define a central model-default contract with tests, and require explicit setting for deployment-critical model families if the runtime has a provider selection layer.
  Validation needed: config tests for defaults and override precedence.

- **acceptable boundary:** `plugins/plugin-openai/index.ts:221` parses `/models` response as `{ data?: unknown[] }` and logs `data.data?.length ?? 0` at `plugins/plugin-openai/index.ts:222`. This is test-only, but it should assert `Array.isArray(data.data)` to catch API shape drift.
  Validation needed: plugin test with malformed `/models` response.

### `plugins/plugin-anthropic`

Classification: **mostly acceptable; one must-fix config fallback.**

Material findings:

- **must-fix:** `plugins/plugin-anthropic/utils/config.ts:131` through `plugins/plugin-anthropic/utils/config.ts:152` converts invalid CoT budget values to `0`. That hides misconfiguration and changes reasoning behavior.
  Suggested fix pattern: throw a configuration error for malformed positive-integer settings; reserve `0` for explicit `"0"` if disabling is intended.
  Validation needed: config tests for invalid, zero, positive, and unset budgets.

- **acceptable boundary:** API key validation is explicit at `plugins/plugin-anthropic/utils/config.ts:39` through `plugins/plugin-anthropic/utils/config.ts:43`, and optional key handling is explicit at `plugins/plugin-anthropic/utils/config.ts:45` through `plugins/plugin-anthropic/utils/config.ts:51`.
  Validation needed: existing auth tests.

- **acceptable boundary:** Browser base URL fallback at `plugins/plugin-anthropic/utils/config.ts:53` through `plugins/plugin-anthropic/utils/config.ts:60` is clear. Ensure browser requests require proxy mode and never ship API keys to clients.
  Validation needed: browser bundle/config test.

### `plugins/plugin-elizacloud`

Classification: **acceptable generated suppression; must-fix where generated route surface is treated as hand-authored API contract.**

Material findings:

- **acceptable boundary:** `plugins/plugin-elizacloud/src/utils/cloud-sdk/public-routes.ts:1` disables explicit-any in a generated file. The file states it is generated at `plugins/plugin-elizacloud/src/utils/cloud-sdk/public-routes.ts:2` and should not be edited by hand at `plugins/plugin-elizacloud/src/utils/cloud-sdk/public-routes.ts:4`.
  Suggested fix pattern: move suppression into the generator output header and add generator tests. If generated route types can be `unknown`/`JsonValue` instead of `any`, fix the generator rather than this file.
  Validation needed: run route generator and assert no hand-edited drift.

- **must-fix:** Cloud SDK/bridge methods use `Record<string, unknown>` returns at the service boundary, e.g. `plugins/plugin-elizacloud/src/services/cloud-bridge.ts:313` and `plugins/plugin-elizacloud/src/services/cloud-bridge.ts:321`. This is acceptable at HTTP JSON ingress only if each public method validates the expected response shape before returning.
  Suggested fix pattern: add per-method response parsers (`parseAgentStatus`, `parseCloudMessageResponse`) and return typed results.
  Validation needed: mocked cloud responses with missing fields and extra fields.

### `plugins/plugin-workflow`

Classification: **must-fix fallback-to-success/deploy behavior; test suppressions acceptable.**

Material findings:

- **must-fix:** `plugins/plugin-workflow/src/services/workflow-service.ts:418` through `plugins/plugin-workflow/src/services/workflow-service.ts:429` proceeds to deploy with `_meta.requiresClarification` after unrecoverable validation/repair errors. This can create workflows known to be invalid.
  Suggested fix pattern: return a draft requiring clarification instead of deploying, or make deployment require an explicit `allowInvalidDraft` flag.
  Validation needed: generation test where repair fails verifies no deployment happens.

- **must-fix:** `plugins/plugin-workflow/src/services/workflow-service.ts:713` through `plugins/plugin-workflow/src/services/workflow-service.ts:723` falls back from failed update to create. If update fails because of auth, network, or validation, this can duplicate workflows.
  Suggested fix pattern: fallback to create only on verified 404/not-found. Re-throw typed credential, validation, and transport errors.
  Validation needed: update failure matrix: 404 creates, 401/403/500 do not create.

- **must-fix:** `plugins/plugin-workflow/src/services/workflow-service.ts:735` through `plugins/plugin-workflow/src/services/workflow-service.ts:747` logs activation failure but still returns a deployed workflow. That can present inactive workflows as ready.
  Suggested fix pattern: return deployment status `{ deployed, active, activationError }` and require caller/UI to surface inactive state.
  Validation needed: activation failure test.

- **must-fix:** `plugins/plugin-workflow/src/services/workflow-dispatch.ts:190` through `plugins/plugin-workflow/src/services/workflow-dispatch.ts:204` catches execution failure and returns `{ ok: false }`. This is acceptable for dispatch API shape only if callers persist/report failed dispatches. Audit callers to ensure no one treats resolved promise as success.
  Validation needed: scheduled workflow dispatch failure test.

- **acceptable boundary:** `plugins/plugin-workflow/__tests__/unit/clarification.test.ts:70` and `plugins/plugin-workflow/__tests__/unit/workflow-clarification.test.ts:204` use `@ts-expect-error` to exercise malformed runtime guards. Keep as test-only.

### `plugins/plugin-agent-orchestrator`

Classification: **mostly acceptable ANSI/terminal boundaries; must-fix silent route fallbacks.**

Material findings:

- **must-fix:** `plugins/plugin-agent-orchestrator/src/api/bridge-routes.ts:103` through `plugins/plugin-agent-orchestrator/src/api/bridge-routes.ts:108` and `plugins/plugin-agent-orchestrator/src/api/bridge-routes.ts:147` through `plugins/plugin-agent-orchestrator/src/api/bridge-routes.ts:151` swallow task thread lookup failures with `.catch(() => null)`. `plugins/plugin-agent-orchestrator/src/api/bridge-routes.ts:164` through `plugins/plugin-agent-orchestrator/src/api/bridge-routes.ts:170` similarly returns empty memory on read failure.
  Suggested fix pattern: distinguish no thread/no room from registry/storage failure; return typed 503/diagnostic body for failures.
  Validation needed: bridge route tests with task registry rejection and runtime memory rejection.

- **acceptable boundary:** ANSI/control-character suppressions in `plugins/plugin-agent-orchestrator/src/services/ansi-utils.ts:11` through `plugins/plugin-agent-orchestrator/src/services/ansi-utils.ts:23` and `plugins/plugin-agent-orchestrator/src/services/swarm-decision-loop.ts:216` are narrow and justified.
  Validation needed: ansi strip tests.

- **acceptable boundary with follow-up:** `unknown` in session-log parsing, e.g. `plugins/plugin-agent-orchestrator/src/services/session-log-reader.ts`, is appropriate for Claude Code JSONL. Keep parser guards close to casts.
  Validation needed: malformed JSONL fixture tests.

### `plugins/plugin-sql`

Classification: **mostly acceptable; one must-fix fallback check.**

Material findings:

- **must-fix:** `plugins/plugin-sql/src/index.ts:163` through `plugins/plugin-sql/src/index.ts:176` catches errors while probing existing database adapters and treats them as "no adapter registered". If the probe fails due to runtime corruption, plugin-sql may create/register a second adapter.
  Suggested fix pattern: only fallback on known "not registered" conditions; otherwise throw and fail init clearly.
  Validation needed: runtime fake where `getDatabaseAdapter` throws.

- **acceptable boundary:** `plugins/plugin-sql/src/index.ts:106` through `plugins/plugin-sql/src/index.ts:115` fail clearly when data isolation lacks `ELIZA_SERVER_ID`. Keep.

- **acceptable boundary:** Global singleton cast at `plugins/plugin-sql/src/index.ts:70` is a process-level registry boundary. Keep it localized.
  Validation needed: repeated init/shutdown tests.

### `plugins/app-training`

Classification: **must-fix for stale/partial operational fallback; acceptable for explicit JSON parsing with errors.**

Material findings:

- **acceptable boundary:** `plugins/app-training/src/services/training-vast-service.ts:194` through `plugins/app-training/src/services/training-vast-service.ts:214` parses registry JSON, throws on invalid JSON/shape, and narrows entries. This is the desired pattern.

- **must-fix:** `plugins/app-training/src/services/training-vast-service.ts:397` through `plugins/app-training/src/services/training-vast-service.ts:411` logs eval output parse failures but returns `summary: null`, and `plugins/app-training/src/services/training-vast-service.ts:447` through `plugins/app-training/src/services/training-vast-service.ts:459` silently drops malformed checkpoint eval JSON. This hides corrupt eval artifacts.
  Suggested fix pattern: return `{ summary: null, summaryError }` and `{ evaluated: false, evalError }`, or mark checkpoint/eval status as corrupt.
  Validation needed: malformed `_eval.json` and malformed eval output tests.

- **must-fix:** `plugins/app-training/src/services/training-vast-service.ts:560` through `plugins/app-training/src/services/training-vast-service.ts:568` treats any backend budget snapshot error as unavailable and returns `null`; `plugins/app-training/src/services/training-vast-service.ts:572` through `plugins/app-training/src/services/training-vast-service.ts:575` returns `null` on parse failure. That can hide billing/state problems.
  Suggested fix pattern: typed budget result `{ status: "ok" | "unavailable" | "error"; error? }`, with stale marker only for known instance-destroyed/unreachable cases.
  Validation needed: vastai unreachable, instance missing, invalid JSON, and script failure tests.

- **acceptable boundary:** `plugins/app-training/src/services/training-vast-service.ts:766` through `plugins/app-training/src/services/training-vast-service.ts:787` and `plugins/app-training/src/services/training-vast-service.ts:789` through `plugins/app-training/src/services/training-vast-service.ts:805` use `unknown` plus narrowers. Keep this pattern.

### `plugins/app-companion`

Classification: **acceptable UI/library boundary.**

Material findings:

- **acceptable boundary:** `plugins/app-companion/src/components/avatar/VrmEngine.ts:39` suppresses `noExplicitAny` for Three.js TSL shader nodes at `plugins/app-companion/src/components/avatar/VrmEngine.ts:40`. The surrounding interfaces at `plugins/app-companion/src/components/avatar/VrmEngine.ts:26` through `plugins/app-companion/src/components/avatar/VrmEngine.ts:35` already constrain usage.
  Suggested fix pattern: keep as a local alias; do not let `TslNode` leak into app state or props.
  Validation needed: VRM render smoke.

- **acceptable boundary:** `plugins/app-companion/src/components/avatar/VrmEngine.ts:1763` casts `MToonNodeMaterial` through `unknown` for third-party loader constructor mismatch.
  Suggested fix pattern: add a small compatibility type or module augmentation if this recurs.
  Validation needed: WebGPU/VRM loader smoke.

- **acceptable boundary:** `plugins/app-companion/src/components/chat/ChatAvatar.tsx:60` suppresses exhaustive deps intentionally for VRM path reset.
  Validation needed: component test or visual smoke that changing `vrmPath` resets loading UI.

### `plugins/app-task-coordinator`

Classification: **acceptable with one follow-up.**

Material findings:

- **acceptable boundary:** `plugins/app-task-coordinator/src/index.ts:26` through `plugins/app-task-coordinator/src/index.ts:29` use lint suppressions and `globalThis as any` as a Bun bundle-safety sink. The comment explains the runtime failure mode. Keep isolated.
  Suggested fix pattern: move bundle-safety helpers into a typed shared utility if more barrels need this pattern.
  Validation needed: Bun build/tree-shake regression test.

- **acceptable boundary:** ANSI regex suppressions at `plugins/app-task-coordinator/src/PtyTerminalPane.tsx:122` and `plugins/app-task-coordinator/src/PtyTerminalPane.tsx:140` are narrow.

- **must-fix:** `plugins/app-task-coordinator/src/PtyTerminalPane.tsx:118` through `plugins/app-task-coordinator/src/PtyTerminalPane.tsx:128` catches buffer hydration failure and treats it as session-ended. This can hide API/server errors.
  Suggested fix pattern: catch known 404/410 as ended; surface other errors in terminal status.
  Validation needed: buffered output API rejection test.

### `plugins/app-wallet`

Classification: **must-fix for financial zero fallbacks; UI absence fallbacks acceptable.**

Material findings:

- **must-fix:** `plugins/app-wallet/src/inventory/useInventoryData.ts:91`, `plugins/app-wallet/src/inventory/useInventoryData.ts:92`, `plugins/app-wallet/src/inventory/useInventoryData.ts:104`, `plugins/app-wallet/src/inventory/useInventoryData.ts:105`, `plugins/app-wallet/src/inventory/useInventoryData.ts:154`, `plugins/app-wallet/src/inventory/useInventoryData.ts:155`, `plugins/app-wallet/src/inventory/useInventoryData.ts:166`, and `plugins/app-wallet/src/inventory/useInventoryData.ts:167` use `Number.parseFloat(...) || 0`. Invalid/missing balances become zero and can suppress provider/data quality problems.
  Suggested fix pattern: parse with `parseFiniteNumber(value): number | null`; show unknown/degraded states separately from zero.
  Validation needed: inventory data tests for invalid numeric strings, empty strings, real zero, and missing provider fields.

- **acceptable boundary:** localStorage preference parse catches at `plugins/app-wallet/src/InventoryView.tsx:149`, `plugins/app-wallet/src/InventoryView.tsx:161`, `plugins/app-wallet/src/InventoryView.tsx:253`, and `plugins/app-wallet/src/InventoryView.tsx:263` are acceptable UI preference fallbacks.
  Suggested fix pattern: keep isolated to preferences; do not reuse for wallet/provider data.

- **must-fix:** `plugins/app-wallet/src/widgets/wallet-status.tsx:143` through `plugins/app-wallet/src/widgets/wallet-status.tsx:148` silently ignores clipboard failure. It is low severity but should show copy failure state for user trust.
  Validation needed: clipboard unavailable UI test.

## Other material packages

### `plugins/app-steward`

Classification: **needs follow-up audit.**

Material signal: no suppressions, only 3 `any`, but 297 try/catch matches. Given steward likely orchestrates operator workflows, audit defensive catches that turn command/deploy failures into status-only warnings.

Suggested validation: route/service tests for failure propagation and UI degraded state.

### `plugins/plugin-music`

Classification: **needs follow-up audit.**

Material signal: 320 try/catch matches and 27 `any`. External media provider APIs commonly use empty-array fallbacks; verify that provider failure is not shown as "no songs/results".

Suggested validation: mocked provider network failure and malformed response tests.

### `plugins/plugin-social-alpha`

Classification: **must-fix follow-up for broad `any`.**

Material findings:

- `plugins/plugin-social-alpha/src/types.ts:102` suppresses explicit `any` for generic SQLite mapping.
- `plugins/plugin-social-alpha/src/types.ts:104` uses a Biome suppression for interface index signatures.
- `plugins/plugin-social-alpha/src/utils.ts:13` suppresses explicit `any` for zod-to-json-schema v3/v4 compatibility.

Suggested fix pattern: replace generic SQLite `any` with `unknown` plus narrowers or `JsonValue`; isolate zod compatibility into a single adapter.
Validation needed: SQLite row mapping tests and zod schema conversion tests.

## Prioritized TODOs

1. Remove production `@ts-nocheck` from LifeOps mixins in slices, starting with smaller connector/status mixins, while preserving the one-`ScheduledTask` runner and structural behavior contract.
2. Remove or isolate the 83 `@ts-nocheck` wallet files behind typed provider/service adapters. Prioritize `analytics/birdeye`, `analytics/token-info`, and canonical LP action/service paths.
3. Replace local-ai `@ts-nocheck` with facade types for transformers/node-llama/ffmpeg managers. First targets: `environment.ts`, `structured-output.ts`, then `index.ts` initialization state.
4. Harden workflow deployment: no create fallback except verified 404; no deployment of unrepaired invalid workflows without explicit operator confirmation; activation failure must be a returned state.
5. Fix financial numeric fallbacks in `plugin-wallet` and `app-wallet`: invalid/missing provider data must not become zero.
6. Add error result unions for agent-orchestrator bridge routes and app-task-coordinator PTY hydration so storage/API failures are not indistinguishable from empty sessions.
7. Split optional vs required auth headers in `plugin-openai`; add config tests for OpenAI and Anthropic model/budget defaults.
8. Convert plugin-sql adapter probing catch into known-not-registered handling only.
9. Keep generated/terminal/UI suppressions, but document them in package-level lint exceptions and add generator/build/smoke tests.
10. Schedule follow-up audits for `app-steward`, `plugin-music`, and `plugin-social-alpha`.

## Suggested validation commands

Run after implementation hardening, not for this report-only audit:

- `bun run lint:default-packs`
- `bun test plugins/app-lifeops/test`
- `bun test plugins/plugin-workflow`
- `bun test plugins/plugin-sql`
- `bun test plugins/plugin-wallet`
- `bun test plugins/app-wallet`
- `bun test plugins/plugin-openai plugins/plugin-anthropic`
- Targeted local-ai smoke tests for tokenizer, embedding, text generation, vision, transcription, and TTS where local model dependencies are available.

