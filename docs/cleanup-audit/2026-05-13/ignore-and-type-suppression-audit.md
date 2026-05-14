# Ignore and Type Suppression Cleanup Audit

Date: 2026-05-13

Scope: dry-run, repo-wide audit under `/Users/shawwalters/eliza-workspace/milady/eliza`. No source code was changed.

## Method

- Enumerated tracked files with `git ls-files`.
- Scanned text/source files for TypeScript suppressions, lint suppressions, explicit `any`/`unknown`, `as unknown as`/`as any as` double casts, non-null assertions, empty catches, catch fallback returns, and empty array/object fallbacks.
- Reviewed `biome.json`, `.biomeignore`, ESLint config, `tsconfig*.json`, and `package.json` lint/typecheck scripts for package-level settings that hide type or lint problems.
- Reported both repo-wide counts and actionable source counts. The repo includes prior audit docs, benchmark datasets, vendored/native code, generated files, and templates; those are called out where they distort raw numbers.

## Executive Summary

| Area | Repo-wide count | Actionable source count | Risk | Notes |
| --- | ---: | ---: | --- | --- |
| `@ts-nocheck` | 1 | 0 | Low | Only appears in prior audit markdown, not active source. |
| `@ts-ignore` | 9 | 2 | Medium | Active source hits are in `packages/app-core/scripts/pre-review-local.mjs`; other hits are docs/templates. |
| `@ts-expect-error` | 15 | 9 | Medium | Active source is concentrated in one MLX server test plus pre-review guard text. |
| `eslint-disable*` | 74 | 70 | Medium | Mostly line-level, but includes generated files and one file-wide wallet browser shim. |
| `biome-ignore*` | 107 | 103 | Medium | Mostly line-level with reasons; largest clusters are UI a11y/hooks, ANSI/control regex, bundle-safety sinks, test fakes. |
| Explicit `any` | 222 | 181 | High | Concentrated in `plugins/plugin-social-alpha`, metrics dashboard, tests, and generated/API compatibility code. |
| Explicit `unknown` | 16,548 | 16,265 | Low/Medium | Mostly legitimate boundary typing; useful as a triage map rather than a cleanup target. |
| Double casts | 580 | 579 | High | `as unknown as` / `as any as` are common in tests and service adapters. |
| Non-null assertions | 1,571 | 1,183 | High | Heavy in tests and cloud services; production instances need nullability review. |
| `catch (e: any)` | 9 | 9 | Medium | Small and fixable. |
| Empty `catch {}` | 186 | 176 | Medium/High | Includes browser/window cleanup and shims; some should log, narrow, or return typed result errors. |
| Catch fallback returns | 2,225 | 2,215 | High | Strong signal for swallowed operational errors, especially API routes and service wrappers. |
| `?? []` / `|| []` | 2,604 | 2,599 | Medium | Needs semantic triage: many are legitimate defaults, but relationship/task/capability paths can hide missing data. |
| `?? {}` / `|| {}` | 1,678 | 1,676 | Medium | Same risk profile as empty array defaults; high in DB/adapters/API clients. |

## Active TypeScript Suppressions

### `@ts-nocheck`

No active source use found.

Raw hit:

| Count | File | Risk | Proposed fix |
| ---: | --- | --- | --- |
| 1 | `docs/audits/repo-cleanup-2026-05-12/suppressions-any-fallbacks.md` | None | Documentation literal; no source action. |

### `@ts-ignore`

| Count | File | Risk | Proposed fix | Validation |
| ---: | --- | --- | --- | --- |
| 2 | `packages/app-core/scripts/pre-review-local.mjs` | Medium | These are scanner guard strings, not applied TypeScript directives. Escape or fixture-isolate them if future audits should not count them. | `node packages/app-core/scripts/pre-review-local.mjs` if it has a dry-run mode; otherwise run package script that owns pre-review checks. |

Non-source/docs/template hits:

- `docs/audits/repo-cleanup-2026-05-12/suppressions-any-fallbacks.md` has 3 documentation literals.
- `docs/audits/repo-cleanup-2026-05-12/IMPLEMENTATION_TODO.md` has 1 documentation literal.
- `docs/audits/repo-cleanup-2026-05-11/phase-2-validation/research-gaps-weaknesses-optimization.md` has 1 documentation literal.
- `packages/elizaos/templates/min-plugin/SCAFFOLD.md` has 1 guidance literal.
- `packages/elizaos/templates/min-project/SCAFFOLD.md` has 1 guidance literal.

### `@ts-expect-error`

| Count | File | Risk | Proposed fix | Validation |
| ---: | --- | --- | --- | --- |
| 8 | `plugins/plugin-local-inference/src/services/mlx-server.test.ts` | Medium | Replace private route-state access with a typed test seam/helper, or assert through public behavior. Keep `@ts-expect-error` only if the test intentionally verifies private state and each directive includes a reason. | `bun test plugins/plugin-local-inference/src/services/mlx-server.test.ts` or the plugin's test script. |
| 1 | `packages/app-core/scripts/pre-review-local.mjs` | Low | Scanner literal, not an applied directive. Escape or fixture-isolate if desired. | Pre-review script test/manual run. |

## Lint Suppressions

### `eslint-disable*`

Top active source files:

| Count | File | Risk | Proposed fix |
| ---: | --- | --- | --- |
| 3 | `packages/benchmarks/configbench/src/handlers/eliza.ts` | Low/Medium | `no-console` in benchmark handler; keep if benchmark output is expected, otherwise route through a logger. |
| 3 | `plugins/plugin-local-inference/src/services/__tests__/runtime-dispatcher.test.ts` | Low | Replace unused callback args with `_`-prefixed names or typed helper objects. |
| 2 | `packages/app-core/test/scripts/test-parallel.mjs` | Low | `no-await-in-loop`; document sequential dependency or refactor to queue/promise pool. |
| 2 | `packages/app/vite/native-module-stub-plugin.ts` | Medium | Replace dynamic `require` with typed dynamic import or isolate Node-only loading. |
| 2 | `packages/benchmarks/personality-bench/tests/judge.test.ts` | Low | Test logging; keep with reason or route through test logger. |
| 2 | `packages/core/scripts/perf-settings.ts` | Low | Script logging; acceptable if explicitly script-only. |
| 2 | `packages/core/src/streaming-context.ts` | Medium | Dynamic require path; wrap with typed module loader. |
| 2 | `packages/elizaos/templates/project/apps/app/vite.config.ts` | Low/Medium | Template Vite config dynamic require; prefer typed import if supported. |
| 2 | `packages/ui/src/state/AppContext.tsx` | Medium | React hooks dependency suppression; verify stale closure risk. |
| 2 | `plugins/plugin-computeruse/src/platform/driver.ts` | Low | Console output in driver; route through logger if production-visible. |
| 2 | `plugins/plugin-local-inference/src/services/__stress__/cache-100conv-stress.test.ts` | Low | Stress-test logging; likely acceptable. |

Notable generated/file-wide suppressions:

- `cloud/apps/api/src/_router.generated.ts` has file-wide `/* eslint-disable */` and `biome-ignore-all` for generated router imports. Risk is low if generation is deterministic and the source generator is checked.
- `cloud/apps/api/src/_generate-router.mjs` emits the generated suppressions. Risk is low; validate generated output after generator edits.
- `cloud/packages/sdk/src/public-routes.ts` has file-wide `@typescript-eslint/no-explicit-any` suppression. Risk is medium because SDK public types can spread `any`.
- `plugins/plugin-elizacloud/src/utils/cloud-sdk/public-routes.ts` has the same SDK-style file-wide suppression.
- `plugins/plugin-wallet/src/browser-shim/shim.template.js` has `/* eslint-disable */` plus `biome-ignore-all`. Risk is medium: browser shims are compatibility-heavy, but file-wide disables can hide real regressions.

### `biome-ignore*`

Top active source files:

| Count | File | Risk | Proposed fix |
| ---: | --- | --- | --- |
| 6 | `packages/app-core/src/benchmark/__tests__/server-role-seeding.test.ts` | Low/Medium | Replace repeated structural fakes with typed fake factory. |
| 6 | `plugins/plugin-agent-orchestrator/src/services/ansi-utils.ts` | Low | ANSI/control-regex suppressions are likely justified; centralize regex constants and keep reasons. |
| 4 | `packages/ui/src/components/config-ui/config-field.tsx` | Medium | A11y/autofocus/index-key suppressions; audit DOM labels and stable keys. |
| 3 | `packages/app-core/platforms/electrobun/src/rpc-handlers.ts` | Medium | Replace `any` bridge suppressions with generic request handler types or adapter wrappers. |
| 3 | `packages/ui/src/components/character/CharacterEditorPanels.tsx` | Medium | Replace index keys with stable IDs where possible. |
| 3 | `packages/ui/src/components/pages/RuntimeView.tsx` | Medium/High | Verify `noLabelWithoutControl`; use explicit `htmlFor`/`id` or existing label component. |
| 3 | `plugins/plugin-vision/src/types/lib-fixes.d.ts` | Medium | Type shim should be minimized and linked to upstream type gaps. |
| 2 | `cloud/services/agent-server/src/routes.ts` | Low | `useHookAtTopLevel` false positive for runtime helper named `useRuntime`; consider rename/wrapper. |
| 2 | `packages/ui/src/components/pages/RelationshipsGraphPanel.tsx` | Medium | A11y suppressions around graph interactions; verify keyboard/focus alternative. |
| 2 | `packages/ui/src/components/pages/WorkflowGraphViewer.tsx` | Medium | Hook deps and static interactions; test graph reset behavior and keyboard access. |

## Type Hotspots

### Explicit `any`

Top active source files:

| Count | File | Risk | Proposed fix | Validation |
| ---: | --- | --- | --- | --- |
| 16 | `plugins/plugin-social-alpha/src/services/PriceDataService.ts` | High | Introduce provider DTOs and parsing/narrowing at API boundaries. | Plugin unit tests plus typecheck. |
| 14 | `plugins/plugin-social-alpha/src/services/SimulationService.ts` | High | Type simulation inputs/results; avoid passing untyped actor/market payloads. | Plugin unit tests and simulation smoke test. |
| 12 | `plugins/plugin-social-alpha/src/routes.ts` | High | Type route request/response schemas and external service payloads. | Route tests/API smoke. |
| 12 | `packages/benchmarks/skillsbench/experiments/metrics-dashboard/server/index.ts` | Medium | Define metric/job DTOs; benchmark tooling risk is lower than runtime services. | Metrics dashboard smoke test. |
| 8 | `plugins/plugin-social-alpha/src/service.ts` | High | Type service state and action results; avoid generic plugin payload escape hatches. | Plugin test script. |
| 7 | `cloud/packages/tests/integration/revenue-splits.test.ts` | Low/Medium | Use typed fixtures/builders instead of `any` casts. | Cloud integration test subset. |
| 6 | `cloud/packages/tests/e2e/helpers/app-lifecycle.ts` | Medium | Type lifecycle helper handles and app state. | Cloud e2e helper tests. |
| 6 | `packages/app-core/src/benchmark/__tests__/server-role-seeding.test.ts` | Low/Medium | Typed fake factory. | Benchmark role seeding tests. |
| 6 | `packages/examples/agent-console/server.ts` | Medium | Type route bodies and catch variables. | Example smoke test. |
| 6 | `plugins/plugin-social-alpha/src/clients.ts` | High | Type client responses and convert at boundary. | Plugin unit tests. |

Package concentration:

| Count | Package/root | Risk | Notes |
| ---: | --- | --- | --- |
| 70 | `plugins/plugin-social-alpha` | High | Biggest active `any` hotspot; also has config that ignores unknown files. |
| 36 | `packages/benchmarks` | Medium | Lower runtime risk, but can weaken benchmark reliability. |
| 16 | `cloud/packages/tests` | Low/Medium | Mostly tests; useful quick wins via typed fixtures. |
| 12 | `packages/app-core` | Medium | Some test fake debt, some platform bridge debt. |
| 7 | `cloud/packages/lib` | High | Runtime cloud services should avoid `any` in persistence/API boundaries. |

### Explicit `unknown`

This repo uses `unknown` heavily and often correctly at trust boundaries. Treat this as a triage map, not a blanket cleanup target.

Top files:

| Count | File | Risk | Proposed fix |
| ---: | --- | --- | --- |
| 100 | `plugins/app-lifeops/src/lifeops/repository.ts` | Medium | Verify each `unknown` crosses storage/serialization boundaries and is narrowed before behavior. |
| 80 | `packages/agent/src/runtime/eliza.ts` | Medium | Audit runtime/plugin payload boundaries; prefer schema guards for high-value payloads. |
| 72 | `packages/shared/src/contracts/lifeops.ts` | Low/Medium | Contract-level `unknown` may be correct; ensure consumers narrow structurally. |
| 72 | `plugins/plugin-health/src/contracts/lifeops.ts` | Low/Medium | Same as above for health bridge contracts. |
| 70 | `cloud/packages/sdk/src/types.ts` | Medium | Public SDK types with `unknown` need examples/guards. |
| 68 | `plugins/plugin-local-inference/src/services/voice/ffi-bindings.ts` | Medium | Native FFI boundary; use exact DTO validation where practical. |
| 67 | `cloud/packages/lib/services/eliza-sandbox.ts` | High | Sandbox service inputs/outputs should be schema-narrowed. |
| 67 | `packages/core/src/services/message.ts` | High | Messaging service is central; validate defaults/fallbacks around `unknown`. |

### Double casts

Double casts are a stronger smell than plain `unknown`; they frequently bypass structural checks.

Top active source files:

| Count | File | Risk | Proposed fix |
| ---: | --- | --- | --- |
| 34 | `cloud/packages/tests/unit/steward-sync.test.ts` | Low/Medium | Replace with typed fixture builders. |
| 19 | `plugins/plugin-sql/src/__tests__/migration/transaction-and-concurrency.real.test.ts` | Low/Medium | Typed DB/runtime test fixtures. |
| 8 | `packages/app-core/src/benchmark/__tests__/role-seeding.test.ts` | Low/Medium | Typed benchmark fake factory. |
| 7 | `packages/core/src/features/payments/actions/payment.ts` | High | Production payment path; replace with schema narrowing or domain types. |
| 7 | `packages/core/src/services/message.ts` | High | Central messaging path; replace casts with discriminated unions/guards. |
| 7 | `plugins/app-lifeops/test/journey-extended-coverage.test.ts` | Low/Medium | Typed journey test fixtures. |
| 7 | `plugins/plugin-local-inference/src/services/dflash-server.test.ts` | Low | Test fixture typing. |
| 7 | `plugins/plugin-local-inference/src/services/engine.voice.test.ts` | Low | Test fixture typing. |
| 7 | `plugins/plugin-sql/src/__tests__/migration/runtime-migrator.real.test.ts` | Low/Medium | Typed migration fixtures. |

## Nullability Hotspots

Top active source files for non-null assertions:

| Count | File | Risk | Proposed fix |
| ---: | --- | --- | --- |
| 58 | `cloud/packages/tests/integration/services/agent-budgets.service.test.ts` | Low/Medium | Use fixture builders returning non-null typed records. |
| 44 | `cloud/packages/tests/integration/services/redeemable-earnings.service.test.ts` | Low/Medium | Same: typed setup helpers. |
| 34 | `cloud/packages/tests/unit/eliza-app/cross-platform-linking.test.ts` | Low/Medium | Typed fixtures. |
| 33 | `cloud/packages/tests/integration/services/users-join-regression.test.ts` | Low/Medium | Typed database setup helpers. |
| 32 | `cloud/packages/tests/integration/services/users.service.test.ts` | Low/Medium | Typed fixtures. |
| 23 | `cloud/packages/tests/integration/services/api-keys.service.test.ts` | Low/Medium | Typed fixtures. |
| 20 | `packages/os/linux/agent/tests/runtime/flows/persistence-flow.test.ts` | Low/Medium | Typed flow fixture state. |
| 17 | `cloud/packages/lib/services/vertex-model-registry.ts` | High | Production service; replace `!` with guard/error path. |
| 17 | `packages/app-core/test/live-agent/lens-connector.live.e2e.test.ts` | Medium | Live test setup guard helpers. |
| 17 | `packages/os/linux/agent/tests/runtime/flows/wifi-flow.test.ts` | Low/Medium | Typed flow fixture state. |
| 16 | `packages/app-core/test/live-agent/matrix-connector.live.e2e.test.ts` | Medium | Live test setup guard helpers. |
| 15 | `cloud/services/operator/capabilities/controller/generators.ts` | High | Production operator path; replace with explicit validation and typed errors. |
| 13 | `plugins/plugin-todos/src/actions/todo.test.ts` | Low | Typed fixtures. |
| 12 | `cloud/packages/lib/services/eliza-app/user-service.ts` | High | Production user service; replace with guards/domain errors. |

Package/root concentration:

| Count | Package/root | Risk | Notes |
| ---: | --- | --- | --- |
| 399 | `cloud/packages/tests` | Low/Medium | Mostly fixture cleanup, high volume but lower runtime risk. |
| 344 | `packages/benchmarks` | Medium | Can hide benchmark data/flow assumptions. |
| 170 | `cloud/apps/api` | High | Production API paths need targeted review. |
| 154 | `cloud/packages/lib` | High | Production cloud service layer. |
| 54 | `packages/app-core` | Medium | Mix of tests/platform code. |
| 52 | `plugins/app-lifeops` | High | LifeOps scheduling/runner paths should avoid nullable task/relationship assumptions. |

## Catch and Fallback Patterns

### `catch (e: any)`

| Count | File | Risk | Proposed fix |
| ---: | --- | --- | --- |
| 4 | `packages/examples/agent-console/server.ts` | Medium | Use `catch (error: unknown)` with message extraction helper. |
| 3 | `plugins/plugin-social-alpha/src/routes.ts` | High | Route errors should narrow unknown and return typed error payloads. |
| 1 | `plugins/plugin-social-alpha/src/clients.ts` | High | Client boundary should return typed result/errors. |
| 1 | `plugins/plugin-social-alpha/src/services/historicalPriceService.ts` | High | External price history boundary should preserve error cause. |

### Empty catches

Top active source files:

| Count | File | Risk | Proposed fix |
| ---: | --- | --- | --- |
| 20 | `packages/shared/src/utils/browser-tabs-renderer-registry.ts` | High | Empty catches in shared browser tab registry can hide renderer/runtime failures; log at debug or return typed result. |
| 12 | `packages/benchmarks/skillsbench/experiments/metrics-dashboard/server/index.ts` | Medium | Benchmark dashboard should at least debug-log cleanup/read failures. |
| 9 | `plugins/plugin-wallet/src/browser-shim/shim.template.js` | Medium | Shim compatibility may justify silence, but isolate with comments and minimal scope. |
| 8 | `plugins/plugin-local-inference/native/verify/tts_step_sweep.mjs` | Low/Medium | Verification script; add debug logging. |
| 7 | `packages/app-core/scripts/patch-deps.mjs` | Medium | Patch script should report skipped/failed patch paths. |
| 5 | `packages/app-core/platforms/electrobun/src/native/screencapture.ts` | High | Native capture failures should surface to caller or telemetry. |
| 5 | `plugins/app-2004scape/src/routes.ts` | Medium/High | Route-level swallowed errors can hide user-visible failures. |
| 5 | `plugins/plugin-sql/src/pglite/manager.ts` | High | DB manager should preserve cleanup/init errors. |
| 4 | `packages/app-core/platforms/electrobun/src/index.ts` | High | Platform runtime failures should not be silently ignored. |
| 4 | `plugins/plugin-openrouter/utils/helpers.ts` | Medium | External provider helper should narrow/log errors. |

### Catch fallback returns

Top active source files:

| Count | File | Risk | Proposed fix |
| ---: | --- | --- | --- |
| 28 | `plugins/plugin-social-alpha/src/service.ts` | High | Replace swallowed service errors with typed `Result` or structured error propagation. |
| 24 | `plugins/plugin-computeruse/src/routes/sandbox-routes.ts` | High | Sandbox route failures should return typed error responses and log cause. |
| 19 | `packages/agent/src/api/skills-routes.ts` | High | API route fallbacks can hide skill loading/permission failures. |
| 15 | `plugins/plugin-local-inference/src/routes/local-inference-compat-routes.ts` | High | Inference compatibility routes should preserve provider/native errors. |
| 14 | `packages/agent/src/api/conversation-routes.ts` | High | Conversation API should not conflate missing data with failures. |
| 14 | `plugins/plugin-agent-orchestrator/src/api/agent-routes.ts` | High | Agent orchestration API needs typed error handling. |
| 13 | `plugins/plugin-streaming/src/api/stream-routes.ts` | High | Streaming route fallback can hide transport/session failures. |
| 12 | `plugins/app-training/src/routes/training-routes.ts` | High | Training routes should distinguish unavailable data from backend errors. |
| 12 | `plugins/plugin-wallet/src/analytics/lpinfo/steer/services/steerLiquidityService.ts` | Medium/High | External analytics fallbacks should preserve provider failure. |
| 11 | `packages/agent/src/api/apps-routes.ts` | High | App route failures need typed response and logs. |

### Empty array/object fallbacks

Top `?? []` / `|| []` files:

| Count | File | Risk | Proposed fix |
| ---: | --- | --- | --- |
| 39 | `packages/core/src/services/message.ts` | High | Message service defaults should distinguish "absent" from "empty" when behavior changes. |
| 21 | `plugins/app-lifeops/test/lifeops-action-gating.integration.test.ts` | Low/Medium | Typed fixture defaults. |
| 20 | `plugins/plugin-sql/src/base.ts` | High | DB adapter should not mask missing rows/schema issues. |
| 19 | `plugins/app-lifeops/src/lifeops/identity-observations.ts` | High | LifeOps identity observations should avoid hiding missing graph edges/entities. |
| 16 | `packages/core/src/runtime.ts` | High | Core runtime defaults deserve targeted review. |
| 15 | `plugins/plugin-workflow/src/services/embedded-workflow-service.ts` | High | Workflow state defaults can hide persistence/step failures. |

Top `?? {}` / `|| {}` files:

| Count | File | Risk | Proposed fix |
| ---: | --- | --- | --- |
| 27 | `plugins/plugin-sql/src/base.ts` | High | Replace empty-object fallbacks with typed default constructors or explicit absent states. |
| 22 | `plugins/plugin-sql/src/runtime-migrator/drizzle-adapters/diff-calculator.ts` | High | Migration diffing should fail loudly on malformed input. |
| 19 | `plugins/plugin-inmemorydb/adapter.ts` | High | Adapter defaults should preserve absent vs empty metadata. |
| 19 | `plugins/plugin-localdb/adapter.ts` | High | Same as in-memory DB adapter. |
| 17 | `plugins/plugin-agent-orchestrator/src/services/task-registry.ts` | High | Task registry should avoid swallowing malformed task definitions. |
| 16 | `plugins/plugin-browser/src/workspace/browser-workspace-desktop.ts` | Medium/High | Browser workspace defaults can hide missing app/window state. |
| 12 | `packages/ui/src/api/client-cloud.ts` | Medium | Client API fallback should not hide bad response shapes. |
| 12 | `plugins/app-lifeops/src/lifeops/service-mixin-discord.ts` | High | LifeOps connector/channel dispatch needs explicit typed outcomes. |

## Package-Specific Ignore and Type Config Risks

### Biome configs

Risky package-level settings:

| File | Setting | Risk | Proposed fix |
| --- | --- | --- | --- |
| `cloud/biome.json` | `noExplicitAny=off`, `noNonNullAssertion=off`, `noUnusedVariables=warn`, `vcs.useIgnoreFile=true` | High | Turn `noExplicitAny`/`noNonNullAssertion` to `warn` first, then ratchet to `error` by package. |
| `packages/elizaos/templates/plugin/biome.json` | `noExplicitAny=off`, `noNonNullAssertion=off` | Medium | Templates teach downstream defaults; prefer warnings with local examples for justified escapes. |
| `packages/examples/_plugin/biome.json` | `noExplicitAny=off`, `noNonNullAssertion=off` | Medium | Same as template. |
| `plugins/plugin-app-control/biome.json` | `noExplicitAny=off` | Medium | Enable as `warn`, fix or suppress local intentional cases. |
| `plugins/plugin-bluebubbles/biome.json` | `noExplicitAny=off` | Medium | Enable as `warn`. |
| `plugins/plugin-bluesky/biome.json` | `noExplicitAny=off` | Medium | Enable as `warn`. |
| `plugins/plugin-capacitor-bridge/biome.json` | `noExplicitAny=off` | Medium | Enable as `warn`. |
| `plugins/plugin-cli/biome.json` | `noExplicitAny=off` | Medium | Enable as `warn`. |
| `plugins/plugin-commands/biome.json` | `noExplicitAny=off` | Medium | Enable as `warn`. |
| `plugins/plugin-discord-local/biome.json` | `noExplicitAny=off` | Medium | Enable as `warn`. |
| `plugins/plugin-discord/biome.json` | `noExplicitAny=off` | Medium | Enable as `warn`. |
| `plugins/plugin-local-inference/biome.json` | `noExplicitAny=off` | Medium | Enable as `warn`; native/FFI subareas can retain local suppressions. |
| `plugins/plugin-whatsapp/biome.json` | `noExplicitAny=off` | Medium | Enable as `warn`. |
| `plugins/plugin-lmstudio/biome.json` | `noUnusedVariables=off`, `noNonNullAssertion=off` | Medium | Turn to `warn`; tests can use local suppressions. |
| `plugins/plugin-mlx/biome.json` | `noUnusedVariables=off`, `noNonNullAssertion=off` | Medium | Turn to `warn`; ML/native boundaries should use typed wrappers. |
| `plugins/plugin-nostr/biome.json` | `noUnusedVariables=off`, `noNonNullAssertion=off` | Medium | Turn to `warn`. |
| `plugins/plugin-ollama/biome.json` | `noUnusedVariables=off`, `noNonNullAssertion=off` | Medium | Turn to `warn`. |
| `plugins/plugin-openrouter/biome.json` | `noUnusedVariables=off`, `noNonNullAssertion=off` | Medium | Turn to `warn`. |
| `plugins/plugin-pdf/biome.json` | `noUnusedVariables=off`, `noNonNullAssertion=off` | Medium | Turn to `warn`. |
| `plugins/plugin-social-alpha/biome.json` | `files.ignoreUnknown=true` | Medium | Audit whether important source/config files are skipped; plugin also has largest explicit `any` count. |

Global ignore file:

- `.biomeignore` excludes `**/*.d.ts`, `**/dist/**`, `**/build/**`, coverage, one optimizer script, and browser-extension generated folders. Ignoring all declaration files is convenient but can hide broken local type shims; consider linting first-party `.d.ts` under `packages/**/src` and `plugins/**/src` separately.
- `plugins/plugin-shell/.biomeignore` and `plugins/plugin-wallet/src/chains/solana/.biomeignore` only ignore `dist`; low risk.

### TypeScript configs

Summary across 329 `tsconfig*.json` files:

| Setting | Count | Risk | Notes |
| --- | ---: | --- | --- |
| `strict=false` | 34 | High | Main risk for packages expected to ship runtime code. |
| `noImplicitAny=false` | 25 | High | Directly permits new implicit `any`. |
| `skipLibCheck=true` | 202 | Medium | Common monorepo performance tradeoff, but can hide broken local declarations. |
| `noEmitOnError=false` | 21 | High | Allows build output despite type errors. |
| `allowJs=true` | 13 | Medium | Fine for migrations, risky when paired with `checkJs=false`. |

High-priority configs to ratchet:

| File | Settings | Risk | Proposed fix |
| --- | --- | --- | --- |
| `packages/agent/tsconfig.json` | `strict=false`, `skipLibCheck=true` | High | Turn on strict incrementally via `tsconfig.strict.json` or per-folder include. |
| `packages/agent/tsconfig.bundle.json` | `strict=false`, `skipLibCheck=true` | High | Align with source typecheck before bundle. |
| `cloud/services/operator/tsconfig.json` | `strict=false`, `skipLibCheck=true` | High | Operator/generator code should get strict nullability first. |
| `packages/app-core/tsconfig.typecheck.json` | `noImplicitAny=false` | High | Ratchet to true after fixing top app-core implicit-any sites. |
| `plugins/app-device-settings/tsconfig.json` | `strict=false`, `skipLibCheck=true` | Medium/High | Plugin runtime code. |
| `plugins/app-documents/tsconfig.json` | `strict=false`, `skipLibCheck=true` | Medium/High | Plugin runtime code. |
| `plugins/app-messages/tsconfig.json` | `strict=false`, `skipLibCheck=true` | High | Messaging runtime code. |
| `plugins/app-training/tsconfig.json` | `strict=false`, `skipLibCheck=true` | High | Training routes have many catch fallback returns. |
| `plugins/plugin-anthropic/tsconfig.json` | `strict=false`, `noEmitOnError=false` | High | Provider plugin should not emit on type errors. |
| `plugins/plugin-bluesky/tsconfig.json` | `strict=false`, `noImplicitAny=false` | High | External network plugin. |
| `plugins/plugin-browser/tsconfig.json` | `strict=false`, `skipLibCheck=true` | High | Browser workspace has fallback/default hotspots. |
| `plugins/plugin-codex-cli/tsconfig.json` | `strict=false`, `noImplicitAny=false` | Medium/High | CLI runtime code. |
| `plugins/plugin-discord-local/tsconfig.json` | `strict=false`, `noImplicitAny=false` | High | Messaging connector. |
| `plugins/plugin-farcaster/tsconfig.json` | `strict=false`, `noImplicitAny=false` | High | External network plugin. |
| `plugins/plugin-google-genai/tsconfig.json` | `strict=false`, `noImplicitAny=false` | High | Provider plugin. |
| `plugins/plugin-groq/tsconfig.json` | `strict=false` | High | Provider plugin. |
| `plugins/plugin-inmemorydb/tsconfig.json` | `strict=false` | High | Storage adapter. |
| `plugins/plugin-linear/tsconfig.json` | `strict=false`, `noImplicitAny=false` | High | External network plugin. |
| `plugins/plugin-openai/tsconfig.json` | `strict=false`, `noImplicitAny=false` | High | Provider plugin. |
| `plugins/plugin-openrouter/tsconfig.json` | `strict=false` | High | Provider plugin. |
| `plugins/plugin-roblox/tsconfig.json` | `strict=false`, `noImplicitAny=false` | Medium/High | External plugin. |
| `plugins/plugin-slack/tsconfig.json` | `strict=false`, `noImplicitAny=false` | High | Messaging connector. |
| `plugins/plugin-tee/tsconfig.json` | `strict=false`, `noImplicitAny=false` | High | Security-sensitive plugin. |
| `plugins/plugin-vision/tsconfig.json` | `strict=false`, `noImplicitAny=false` | High | Vision inference/plugin boundary. |
| `plugins/plugin-wallet/src/chains/evm/tsconfig.json` | `strict=false`, `noImplicitAny=false` | High | Wallet/financial path. |
| `plugins/plugin-wallet/src/chains/solana/tsconfig.json` | `strict=false`, `noImplicitAny=false` | High | Wallet/financial path. |
| `plugins/plugin-zai/tsconfig.json` | `strict=false` | High | Provider plugin. |
| `plugins/tsconfig.build.shared.json` | `strict=false` | Medium/High | Shared build template can normalize weaker package settings. |

Suspicious exclude glob patterns:

- Many plugin build configs use `src*.test.ts`, `src*.test.tsx`, or `src__tests__/**`. If intentional, they should be checked against actual paths; otherwise tests may not be excluded as intended.
- Some configs use broad `***.spec.ts`, `***.e2e.test.ts`, or `***` patterns. These are hard to reason about and can over-exclude source.
- `plugins/plugin-coding-tools/tsconfig.build.json`, `plugins/plugin-device-filesystem/tsconfig.build.json`, and `plugins/plugin-todos/tsconfig.build.json` include broad `exclude=["node_modules","dist","***"]`; verify whether these build configs typecheck anything meaningful.
- `test/scenarios/tsconfig.json` has suspicious path-like excludes such as `**/node_modulesdist*.test.ts`.

### Package scripts

| File | Script | Risk | Proposed fix |
| --- | --- | --- | --- |
| `packages/examples/code/package.json` | `lint:check: bunx @biomejs/biome check . || true` | Medium | Remove `|| true` or mark examples as non-blocking outside CI. |
| `packages/examples/elizagotchi/package.json` | `lint:check: bunx @biomejs/biome check . || true` | Medium | Same. |
| `packages/examples/moltbook/package.json` | `lint:check` and `format:check` both use `|| true` | Medium | Same. |
| `plugins/plugin-social-alpha/package.json` | `format:check: echo "Format check skipped (source is gitignored vendor code)"` | High | This package is the largest active `any` hotspot; add at least `biome check`/typecheck for owned source or document vendor boundary. |
| `plugins/plugin-agent-orchestrator/package.json` | `lint:check ... --no-errors-on-unmatched` | Low | Acceptable for optional globs, but make sure it does not mask empty source sets. |
| `plugins/plugin-agent-skills/package.json` | `lint:check` / `format:check ... --no-errors-on-unmatched` | Low | Same. |

## Proposed Cleanup Order

1. Add a suppression inventory guard that fails on new active source `@ts-ignore`, file-wide `eslint-disable`, unreasoned `biome-ignore`, and new package-level `noExplicitAny=off`.
2. Fix or classify the two active `@ts-ignore` scanner literals in `packages/app-core/scripts/pre-review-local.mjs` so active source count remains zero.
3. Replace the 8 `@ts-expect-error` directives in `plugins/plugin-local-inference/src/services/mlx-server.test.ts` with a typed test helper, or add consistent reasons if private access is intentional.
4. Turn `plugins/plugin-social-alpha` into the first `any` cleanup package: add format/lint/typecheck coverage, then replace route/client/service `any` with DTO schemas.
5. Audit production non-null assertions in `cloud/apps/api`, `cloud/packages/lib`, `plugins/app-lifeops`, `packages/core`, and `cloud/services/operator` before spending time on test-only `!`.
6. Triage high-risk catch fallback files: `packages/agent/src/api/*-routes.ts`, `plugins/plugin-computeruse/src/routes/sandbox-routes.ts`, `plugins/plugin-streaming/src/api/stream-routes.ts`, `plugins/app-training/src/routes/training-routes.ts`, and `plugins/plugin-sql/src/base.ts`.
7. Ratchet TypeScript configs by risk: wallet/provider/messaging/storage/cloud service packages first, examples/templates later.
8. Replace broad `***` and malformed-looking exclude globs in build configs with explicit, tested patterns.

## Quick-Win TODOs

- [ ] Add a small script that computes active source suppression counts and writes JSON for CI trend tracking.
- [ ] Fail CI on new `@ts-ignore` in source; allow docs/templates by path.
- [ ] Require reason text after every new `biome-ignore`.
- [ ] Require a narrower rule name for `eslint-disable`; reject bare file-wide `/* eslint-disable */` outside generated files.
- [ ] Add `plugins/plugin-social-alpha` to real `format:check`, `lint:check`, and `typecheck` coverage or explicitly move vendor code outside owned source.
- [ ] Change `cloud/biome.json` `noExplicitAny` and `noNonNullAssertion` from `off` to `warn`; measure fallout before ratcheting to `error`.
- [ ] Validate whether build configs with `exclude=["node_modules","dist","***"]` include any files.
- [ ] Add typed fixture builders for the top cloud test non-null assertion clusters.
- [ ] Add a shared `getErrorMessage(error: unknown)` helper and replace all 9 `catch (e: any)` uses.
- [ ] Create a typed result/error-response helper for route files with repeated catch fallback returns.

## Validation Needed

After each cleanup slice:

- Run package-local `bun run typecheck` where available.
- Run package-local `bun run lint:check` or `bunx @biomejs/biome check <package>`.
- For route/fallback changes, run targeted API route tests and one smoke test that exercises the error path.
- For LifeOps/plugin-health related defaults or fallbacks, verify scheduled task behavior still follows the single `ScheduledTask` runner architecture and does not introduce prompt-content-driven behavior.
- For provider/wallet/storage plugins, run plugin unit tests plus a minimal integration smoke where available.
- For generated files, regenerate from source and confirm generated suppressions are identical or reduced.

## Reproduction Commands

Use these from repo root.

```sh
git ls-files | wc -l
rg -n --glob '!node_modules/**' --glob '!dist/**' --glob '!build/**' '@ts-nocheck|@ts-ignore|@ts-expect-error|eslint-disable|biome-ignore' .
rg -n --glob '!node_modules/**' --glob '!dist/**' --glob '!build/**' '\\b(as any|: any\\b|as unknown as|as any as)' packages plugins cloud test
rg -n --glob '!node_modules/**' --glob '!dist/**' --glob '!build/**' 'catch\\s*\\([^)]*:\\s*any\\b|catch\\s*(\\([^)]*\\))?\\s*\\{\\s*\\}' packages plugins cloud test
rg -n --glob '!node_modules/**' --glob '!dist/**' --glob '!build/**' 'return\\s+(null|undefined|false|true|\\[\\]|\\{\\})' packages plugins cloud test
rg -n 'strict\"\\s*:\\s*false|noImplicitAny\"\\s*:\\s*false|noEmitOnError\"\\s*:\\s*false|noExplicitAny\"\\s*:\\s*\"off\"|noNonNullAssertion\"\\s*:\\s*\"off\"|\\|\\| true|Format check skipped' --glob 'tsconfig*.json' --glob 'biome.json' --glob 'package.json' .
```
