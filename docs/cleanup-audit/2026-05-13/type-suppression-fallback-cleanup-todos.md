# Type Suppression and Fallback Cleanup TODOs

Date: 2026-05-13

Scope: implementation-ready TODO expansion of `docs/cleanup-audit/2026-05-13/ignore-and-type-suppression-audit.md`. This is a dry-run planning artifact only. Do not delete source files, do not mass-rewrite unrelated code, and do not replace real fixes with broader suppressions.

## Cleanup Rules

- Prefer typed boundaries, typed fixtures, schema guards, and explicit result/error types over `@ts-*`, `eslint-disable`, `biome-ignore`, `as any`, double casts, non-null assertions, or default fallbacks.
- Keep suppressions only when the underlying tool is wrong or the code is generated/compatibility-only. Every retained suppression should be narrow, rule-specific, and reasoned.
- Treat `unknown` as acceptable at trust boundaries only when code narrows before behavior. Do not convert `unknown` to `any`.
- Treat `?? []`, `|| []`, `?? {}`, `|| {}`, optional chaining plus defaults, and broad `catch { return ... }` as suspicious when they hide missing storage rows, malformed provider responses, missing task records, failed dispatches, or route errors.
- Split fixes by package. Avoid cross-package ratchets until the local validation commands pass.

## Priority Order

| Priority | Package/root | Why first |
| --- | --- | --- |
| P0 | `plugins/plugin-social-alpha` | Largest explicit `any` hotspot; route/client/service errors are swallowed; lint/format coverage is skipped. |
| P0 | `packages/agent` | API route fallback returns are high-volume and user/runtime-visible. |
| P0 | `packages/core` | Central runtime/message/payment paths contain double casts and suspicious empty defaults. |
| P0 | `plugins/app-lifeops` | LifeOps must preserve structural `ScheduledTask` behavior; fallbacks can hide task/entity graph bugs. |
| P0 | `plugins/plugin-sql`, `plugins/plugin-localdb`, `plugins/plugin-inmemorydb` | Storage adapters and migration diffing should not conflate absent/malformed data with empty defaults. |
| P0 | `cloud/packages/lib`, `cloud/apps/api` | Production cloud service/API paths contain non-null assertions and catch fallbacks. |
| P1 | `packages/ui` | Hook/a11y suppressions and client API fallbacks can hide user-facing stale state. |
| P1 | `packages/app-core` | Platform bridge, scripts, and benchmark tests have `any`, double casts, empty catches, and suppressions. |
| P1 | `plugins/plugin-local-inference` | `@ts-expect-error` cluster in tests; native/provider route fallbacks need typed errors. |
| P1 | `plugins/plugin-computeruse` | Sandbox route failures and platform non-null assertions need explicit outcomes. |
| P1 | `plugins/plugin-agent-orchestrator`, `plugins/plugin-streaming`, `plugins/app-training` | Route and task/workflow fallback clusters. |
| P1 | `plugins/plugin-wallet` | Wallet/analytics fallbacks and file-wide browser shim suppressions deserve review. |
| P2 | `cloud/packages/tests`, `packages/benchmarks`, `packages/examples` | Mostly fixture/tooling cleanup after runtime paths are stable. |
| P2 | Package configs/templates | Ratchet Biome/TypeScript/package scripts after source hotspots are reduced. |

## Global Guardrails

### TODO G1: Add a suppression inventory guard

- Target: new script under existing repo tooling, not source logic.
- Detect active source uses of `@ts-ignore`, file-wide `eslint-disable`, unreasoned `biome-ignore`, new `as any`, new double casts, and package-level `noExplicitAny=off`.
- Allowlist generated files only by path and generator source, not by broad glob.
- Real fix: fail on new debt while allowing existing debt to be burned down by baseline counts.
- Avoid: a guard that scans docs/templates as active source, or a guard that blocks generated files without a regeneration path.
- Validation:

```sh
rg -n --glob '!node_modules/**' --glob '!dist/**' --glob '!build/**' '@ts-ignore|@ts-expect-error|eslint-disable|biome-ignore' packages plugins cloud test
rg -n --glob '!node_modules/**' --glob '!dist/**' --glob '!build/**' 'as\\s+unknown\\s+as|as\\s+any\\s+as|as\\s+any|:\\s*any\\b' packages plugins cloud test
```

### TODO G2: Establish shared helpers before route cleanup

- Target helpers: error message extraction, typed error response, and `Result<T, E>` or equivalent local pattern where packages already use one.
- Real fix: replace repeated `catch { return null/false/[]/{} }` with explicit `ok/error` outcomes or route responses that include status, code, and cause logging.
- Avoid: replacing `catch (e: any)` with `catch (e: unknown)` and immediately casting to `any`.
- Validation:

```sh
rg -n 'catch\\s*\\([^)]*:\\s*any\\b|catch\\s*\\([^)]*\\)\\s*\\{[\\s\\S]{0,240}?return\\s+(null|undefined|false|true|\\[\\]|\\{\\})' packages plugins cloud test
```

## `plugins/plugin-social-alpha` P0

Hotspots:

- `plugins/plugin-social-alpha/src/services/PriceDataService.ts`: 16 explicit `any`.
- `plugins/plugin-social-alpha/src/services/SimulationService.ts`: 14 explicit `any`.
- `plugins/plugin-social-alpha/src/routes.ts`: 12 explicit `any`, 3 `catch (e: any)`.
- `plugins/plugin-social-alpha/src/service.ts`: 8 explicit `any`, 7 non-null assertions, 28 catch fallback returns.
- `plugins/plugin-social-alpha/src/clients.ts`: 6 explicit `any`, 1 `catch (e: any)`.
- `plugins/plugin-social-alpha/src/services/historicalPriceService.ts`: 1 `catch (e: any)`.
- `plugins/plugin-social-alpha/package.json`: `format:check` is skipped.

### TODO PSA-1: Restore package validation before fixing internals

- Real fix: add real `format:check`, `lint:check`, and typecheck coverage for owned source, or move true vendored code out of owned source and document the boundary.
- Avoid: turning on stricter config and immediately adding local broad disables.
- Validation:

```sh
cd plugins/plugin-social-alpha
bun run typecheck
bun run lint:check
bun run format:check
```

If scripts do not exist yet, use:

```sh
bunx tsc -p plugins/plugin-social-alpha/tsconfig.json --noEmit
bunx @biomejs/biome check plugins/plugin-social-alpha
```

### TODO PSA-2: Type provider/client DTO boundaries

- Target files: `src/clients.ts`, `src/services/PriceDataService.ts`, `src/services/historicalPriceService.ts`, `src/services/priceEnrichmentService.ts`.
- Real fix: define provider response DTOs and parse/narrow external responses once at the boundary. Return typed data or typed provider error.
- Replace `catch (e: any)` with `catch (error: unknown)` plus helper extraction.
- Replace `?? []`/`?? {}` where missing provider fields mean malformed data; fail or mark partial data explicitly.
- Validation:

```sh
bunx tsc -p plugins/plugin-social-alpha/tsconfig.json --noEmit
rg -n 'catch\\s*\\([^)]*:\\s*any\\b|as\\s+any|:\\s*any\\b|\\?\\?\\s*\\[\\]|\\|\\|\\s*\\[\\]|\\?\\?\\s*\\{\\}|\\|\\|\\s*\\{\\}' plugins/plugin-social-alpha/src
```

### TODO PSA-3: Type simulation/service state

- Target files: `src/services/SimulationService.ts`, `src/services/simulationRunner.ts`, `src/services/tokenSimulationService.ts`, `src/service.ts`, `src/simulationActors.ts`.
- Real fix: define domain types for market state, actor state, simulation inputs/results, and action output. Replace non-null assertions with construction-time checks or explicit validation errors.
- For catch fallback returns in `src/service.ts`, distinguish:
  - missing optional data: return a typed empty result with reason;
  - external/provider failure: return typed error and log cause;
  - invariant violation: throw or fail the action.
- Validation:

```sh
bunx tsc -p plugins/plugin-social-alpha/tsconfig.json --noEmit
bun test plugins/plugin-social-alpha
```

## `packages/agent` P0

Hotspots:

- `packages/agent/src/api/skills-routes.ts`: 19 catch fallback returns.
- `packages/agent/src/api/conversation-routes.ts`: 14 catch fallback returns.
- `packages/agent/src/api/apps-routes.ts`: 11 catch fallback returns.
- `packages/agent/src/api/plugin-routes.ts`: 11 catch fallback returns, 8 empty array fallbacks.
- `packages/agent/src/api/wallet-routes.ts`: 10 catch fallback returns.
- `packages/agent/src/api/server.ts`: 7 empty object fallbacks.
- `packages/agent/src/runtime/conversation-compactor-runtime.ts`: double casts and empty object fallbacks.
- `packages/agent/tsconfig.json`: `strict=false`.

### TODO AGENT-1: Replace route catch fallbacks with typed API errors

- Target files: `src/api/skills-routes.ts`, `src/api/conversation-routes.ts`, `src/api/apps-routes.ts`, `src/api/plugin-routes.ts`, `src/api/wallet-routes.ts`, `src/api/inbox-routes.ts`, `src/api/subscription-routes.ts`.
- Real fix: add or reuse a route helper that maps known failures to status-coded responses and logs unknown failures with cause.
- Replace `return []`, `return {}`, `return false`, or `return null` inside catch blocks when the caller needs to distinguish "empty" from "failed".
- Avoid: preserving the old behavior under a new helper named `safe`.
- Validation:

```sh
bunx tsc -p packages/agent/tsconfig.json --noEmit
bun test packages/agent
rg -n 'catch\\s*(\\([^)]*\\))?\\s*\\{[\\s\\S]{0,240}?return\\s+(null|undefined|false|true|\\[\\]|\\{\\})' packages/agent/src/api
```

### TODO AGENT-2: Narrow runtime payloads before behavior

- Target files: `src/runtime/eliza.ts`, `src/runtime/trajectory-internals.ts`, `src/runtime/conversation-compactor-runtime.ts`, `src/api/hono-adapter.ts`, `src/api/dispatch-route.ts`.
- Real fix: add discriminated unions or schema guards for runtime/plugin payloads. Replace double casts with typed adapters.
- Validation:

```sh
bunx tsc -p packages/agent/tsconfig.json --noEmit
rg -n 'as\\s+unknown\\s+as|as\\s+any\\s+as|as\\s+any' packages/agent/src
```

## `packages/core` P0

Hotspots:

- `packages/core/src/services/message.ts`: 7 double casts, 6 catch fallback returns, 39 empty array fallbacks.
- `packages/core/src/features/payments/actions/payment.ts`: 7 double casts.
- `packages/core/src/runtime.ts`: 16 empty array fallbacks.
- `packages/core/src/database/inMemoryAdapter.ts`: 13 empty array fallbacks.
- `packages/core/src/features/advanced-capabilities/actions/message.ts`: 7 empty object fallbacks.
- `packages/core/src/features/documents/service.ts`: 7 empty object fallbacks.
- `packages/core/src/features/trajectories/TrajectoriesService.ts`: 7 empty object fallbacks.
- `packages/core/src/streaming-context.ts`: 2 `eslint-disable` for dynamic require.

### TODO CORE-1: Fix central message service defaults

- Target file: `packages/core/src/services/message.ts`.
- Real fix: define exact types for message metadata/content/tool outputs; replace `as unknown as` with typed construction or schema parsing.
- Review every `?? []` / `|| []`:
  - keep only presentation-level empty defaults;
  - replace data-store or runtime missing state with explicit `MissingMessageField`/typed error where behavior depends on it.
- Validation:

```sh
bunx tsc -p packages/core/tsconfig.json --noEmit
bun test packages/core/src/services/message.ts
rg -n 'as\\s+unknown\\s+as|as\\s+any|\\?\\?\\s*\\[\\]|\\|\\|\\s*\\[\\]' packages/core/src/services/message.ts
```

### TODO CORE-2: Remove production payment double casts

- Target file: `packages/core/src/features/payments/actions/payment.ts`.
- Real fix: type payment action input/output and validate external payload shape before payment behavior.
- Avoid: moving the double cast into a helper without narrowing.
- Validation:

```sh
bunx tsc -p packages/core/tsconfig.json --noEmit
bun test packages/core/src/features/payments
```

### TODO CORE-3: Tighten runtime/database fallback semantics

- Target files: `src/runtime.ts`, `src/database/inMemoryAdapter.ts`, `src/plugin-lifecycle.ts`, `src/runtime/planner-loop.ts`.
- Real fix: replace empty defaults that hide missing plugin/runtime state with typed absent states. Preserve empty arrays only when an empty collection is an explicitly valid domain value.
- Validation:

```sh
bunx tsc -p packages/core/tsconfig.json --noEmit
bun test packages/core/src/runtime
bun test packages/core/src/database
```

## `plugins/app-lifeops` P0

Hotspots:

- `plugins/app-lifeops/src/lifeops/repository.ts`: 100 `unknown`, 6 empty object fallbacks.
- `plugins/app-lifeops/src/lifeops/identity-observations.ts`: 19 empty array fallbacks.
- `plugins/app-lifeops/src/lifeops/service-mixin-discord.ts`: 12 empty object fallbacks, 4 catch fallback returns.
- `plugins/app-lifeops/src/actions/lib/calendar-handler.ts`: 7 empty object fallbacks.
- `plugins/app-lifeops/src/actions/schedule.ts`: explicit `any`.
- `plugins/app-lifeops/src/actions/life.ts`: double casts.
- `plugins/app-lifeops/src/lifeops/service.ts`: Biome suppression for mixin declaration merging.
- `plugins/app-lifeops/src/lifeops/service-mixin-core.ts`: Biome suppression for open-ended constructor signature.

### TODO LIFEOPS-1: Audit repository `unknown` and storage defaults

- Target file: `src/lifeops/repository.ts`.
- Real fix: keep `unknown` at storage boundaries, but add narrowers before constructing entities, relationships, scheduled tasks, packs, and connector records.
- Replace `?? {}` defaults where a missing serialized field should invalidate the record or trigger migration.
- Validation:

```sh
bunx tsc -p plugins/app-lifeops/tsconfig.build.json --noEmit
bun test plugins/app-lifeops/test
rg -n 'unknown|\\?\\?\\s*\\{\\}|\\|\\|\\s*\\{\\}|as\\s+unknown\\s+as|as\\s+any' plugins/app-lifeops/src/lifeops/repository.ts
```

### TODO LIFEOPS-2: Preserve ScheduledTask/entity graph invariants

- Target files: `src/lifeops/identity-observations.ts`, `src/lifeops/context-graph.ts`, `src/lifeops/service-mixin-discord.ts`, `src/actions/lib/calendar-handler.ts`, `src/actions/schedule.ts`.
- Real fix: replace empty collection fallbacks with explicit states: no relationship edge, no connector account, disabled channel, empty default pack, or invalid task.
- Do not add a second task primitive or prompt-instruction-driven behavior. Keep all reminders/check-ins/follow-ups/watchers/recaps/approvals/outputs as `ScheduledTask` records.
- Validation:

```sh
bunx tsc -p plugins/app-lifeops/tsconfig.build.json --noEmit
bun test plugins/app-lifeops/test/lifeops-action-gating.integration.test.ts
bun test plugins/app-lifeops/test/default-packs.smoke.test.ts
bun run lint:default-packs
```

### TODO LIFEOPS-3: Keep mixin suppressions narrow or remove with typed mixin helpers

- Target files: `src/lifeops/service.ts`, `src/lifeops/service-mixin-core.ts`.
- Real fix: introduce a local typed mixin helper if it removes declaration merging suppressions without making runtime inference worse.
- Acceptable retained suppression: narrow Biome rule with reason if TypeScript cannot express the mixin pattern cleanly.
- Validation:

```sh
bunx @biomejs/biome check plugins/app-lifeops/src/lifeops/service.ts plugins/app-lifeops/src/lifeops/service-mixin-core.ts
bunx tsc -p plugins/app-lifeops/tsconfig.build.json --noEmit
```

## Storage Packages P0

Packages: `plugins/plugin-sql`, `plugins/plugin-localdb`, `plugins/plugin-inmemorydb`.

Hotspots:

- `plugins/plugin-sql/src/base.ts`: 20 empty array fallbacks, 27 empty object fallbacks, 5 catch fallback returns.
- `plugins/plugin-sql/src/runtime-migrator/drizzle-adapters/diff-calculator.ts`: 22 empty object fallbacks.
- `plugins/plugin-sql/src/pglite/manager.ts`: 5 empty catches, 4 catch fallback returns.
- `plugins/plugin-localdb/adapter.ts`: 19 empty object fallbacks.
- `plugins/plugin-inmemorydb/adapter.ts`: 19 empty object fallbacks.
- `plugins/plugin-sql/src/__tests__/migration/*.test.ts`: double casts concentrated in fixtures.

### TODO STORE-1: Make adapter absent states explicit

- Real fix: define typed return variants for missing row, empty query result, malformed metadata, and backend failure.
- Replace fallback objects that silently omit fields with constructors/default factories named for the domain default.
- Validation:

```sh
bunx tsc -p plugins/plugin-sql/src/tsconfig.json --noEmit
bunx tsc -p plugins/plugin-localdb/tsconfig.json --noEmit
bunx tsc -p plugins/plugin-inmemorydb/tsconfig.json --noEmit
bun test plugins/plugin-sql/src/__tests__
```

### TODO STORE-2: Fix migration diff fallbacks

- Target: `plugins/plugin-sql/src/runtime-migrator/drizzle-adapters/diff-calculator.ts`.
- Real fix: malformed schema/diff input should return a typed migration planning error, not `{}`.
- Validation:

```sh
bun test plugins/plugin-sql/src/__tests__/migration
rg -n '\\?\\?\\s*\\{\\}|\\|\\|\\s*\\{\\}|catch\\s*(\\([^)]*\\))?\\s*\\{\\s*\\}' plugins/plugin-sql/src
```

### TODO STORE-3: Type migration test fixtures

- Target tests: transaction/concurrency, runtime migrator, schema evolution.
- Real fix: replace `as unknown as` with fixture builders for database adapter/runtime/migration contexts.
- Validation:

```sh
rg -n 'as\\s+unknown\\s+as|as\\s+any\\s+as' plugins/plugin-sql/src/__tests__
bun test plugins/plugin-sql/src/__tests__/migration
```

## Cloud Runtime P0

Packages: `cloud/packages/lib`, `cloud/apps/api`, `cloud/services/operator`.

Hotspots:

- `cloud/packages/lib/services/vertex-model-registry.ts`: 17 non-null assertions, 6 empty object fallbacks.
- `cloud/packages/lib/services/eliza-app/user-service.ts`: 12 non-null assertions.
- `cloud/packages/lib/services/eliza-sandbox.ts`: 67 `unknown`, 7 catch fallback returns.
- `cloud/packages/lib/cache/client.ts`: 6 catch fallback returns.
- `cloud/packages/lib/services/message-router/index.ts`: 6 catch fallback returns.
- `cloud/apps/api`: 170 non-null assertions, route catch fallbacks, generated router suppressions.
- `cloud/services/operator/capabilities/controller/generators.ts`: 15 non-null assertions.
- `cloud/biome.json`: `noExplicitAny=off`, `noNonNullAssertion=off`.

### TODO CLOUD-1: Replace production non-null assertions with guards

- Target first: `vertex-model-registry.ts`, `user-service.ts`, operator generators, high-traffic API routes.
- Real fix: use explicit guards and typed domain errors for missing model IDs, users, orgs, request params, and generated capability data.
- Avoid: `if (!x) return null` when callers need to know whether this is not found vs invariant failure.
- Validation:

```sh
bunx tsc -p cloud/tsconfig.json --noEmit
bun test cloud/packages/lib
bun test cloud/apps/api
rg -n '!\\s*(\\.|\\[|;|,|\\)|\\})' cloud/packages/lib cloud/apps/api cloud/services/operator
```

### TODO CLOUD-2: Type cloud route and service error responses

- Target: API route files with catch fallback returns plus `services/eliza-sandbox.ts`, `cache/client.ts`, `message-router/index.ts`.
- Real fix: adopt shared `unknown` error extraction and typed route responses. Log failure causes once, not at every caller.
- Validation:

```sh
rg -n 'catch\\s*(\\([^)]*\\))?\\s*\\{[\\s\\S]{0,240}?return\\s+(null|undefined|false|true|\\[\\]|\\{\\})' cloud/apps/api cloud/packages/lib cloud/services
bun test cloud/packages/tests
```

### TODO CLOUD-3: Ratchet cloud Biome config after source fixes

- Target: `cloud/biome.json`.
- Real fix: change `noExplicitAny` and `noNonNullAssertion` from `off` to `warn`, then create package-local ratchet PRs toward `error`.
- Validation:

```sh
bunx @biomejs/biome check cloud
```

## `packages/ui` P1

Hotspots:

- `packages/ui/src/components/config-ui/config-field.tsx`: 4 `biome-ignore`.
- `packages/ui/src/components/pages/RuntimeView.tsx`: 3 a11y `biome-ignore`.
- `packages/ui/src/components/character/CharacterEditorPanels.tsx`: 3 index-key suppressions.
- `packages/ui/src/state/AppContext.tsx`: 2 `eslint-disable` for hook deps.
- `packages/ui/src/api/client-agent.ts`: 9 catch fallback returns, empty catches, empty object fallbacks.
- `packages/ui/src/state/persistence.ts`: 9 catch fallback returns.
- `packages/ui/src/api/client-cloud.ts`: 12 empty object fallbacks.

### TODO UI-1: Fix a11y and hook suppressions with real component changes

- Real fix: add stable `id`/`htmlFor`, semantic buttons/labels, stable keys, and dependency-safe hooks. Where graph libraries own interactions, provide keyboard/focus alternatives.
- Avoid: replacing `biome-ignore` with `eslint-disable` or leaving labels visually correct but programmatically unassociated.
- Validation:

```sh
bunx tsc -p packages/ui/tsconfig.json --noEmit
bunx @biomejs/biome check packages/ui/src/components packages/ui/src/state
bun test packages/ui
```

### TODO UI-2: Make client API fallback behavior explicit

- Target: `src/api/client-agent.ts`, `src/api/client-cloud.ts`, `src/state/persistence.ts`, `src/onboarding/probe-local-agent.ts`.
- Real fix: distinguish network failure, bad JSON, unauthenticated, not found, and intentionally empty response.
- Validation:

```sh
rg -n 'catch\\s*(\\([^)]*\\))?\\s*\\{[\\s\\S]{0,240}?return\\s+(null|undefined|false|true|\\[\\]|\\{\\})|\\?\\?\\s*\\{\\}|\\|\\|\\s*\\{\\}' packages/ui/src/api packages/ui/src/state packages/ui/src/onboarding
bun test packages/ui/src/api packages/ui/src/state
```

## `packages/app-core` P1

Hotspots:

- `packages/app-core/scripts/pre-review-local.mjs`: scanner literals counted as `@ts-ignore`/`@ts-expect-error`.
- `packages/app-core/platforms/electrobun/src/rpc-handlers.ts`: 3 `biome-ignore`, 3 explicit `any`.
- `packages/app-core/platforms/electrobun/src/index.ts`: explicit `any`, double casts, empty catches.
- `packages/app-core/src/benchmark/__tests__/server-role-seeding.test.ts`: 6 explicit `any`, 6 `biome-ignore`.
- `packages/app-core/src/benchmark/__tests__/role-seeding.test.ts`: 8 double casts.
- `packages/app-core/scripts/patch-deps.mjs`: 7 empty catches.
- `packages/app-core/platforms/electrobun/src/native/screencapture.ts`: 5 empty catches.

### TODO APP-CORE-1: Remove scanner false positives without weakening guard

- Target: `scripts/pre-review-local.mjs`.
- Real fix: move literal patterns into fixtures or escaped strings so audits count active source accurately.
- Validation:

```sh
node packages/app-core/scripts/pre-review-local.mjs
rg -n '@ts-ignore|@ts-expect-error' packages/app-core/scripts/pre-review-local.mjs
```

### TODO APP-CORE-2: Type Electrobun RPC bridge

- Target: `platforms/electrobun/src/rpc-handlers.ts`, `platforms/electrobun/src/index.ts`.
- Real fix: define typed request/response maps and a small adapter for the untyped Electrobun API. Keep `any` only inside the adapter if unavoidable.
- Validation:

```sh
bunx tsc -p packages/app-core/tsconfig.json --noEmit
bun test packages/app-core/platforms/electrobun
rg -n 'as\\s+any|:\\s*any\\b|biome-ignore' packages/app-core/platforms/electrobun/src
```

### TODO APP-CORE-3: Replace script/platform empty catches

- Target: `scripts/patch-deps.mjs`, `scripts/desktop-build.mjs`, `platforms/electrobun/src/native/screencapture.ts`.
- Real fix: report skipped optional work at debug level and return typed failure where caller behavior changes.
- Validation:

```sh
rg -n 'catch\\s*(\\([^)]*\\))?\\s*\\{\\s*\\}' packages/app-core/scripts packages/app-core/platforms/electrobun/src
bun test packages/app-core
```

## `plugins/plugin-local-inference` P1

Hotspots:

- `plugins/plugin-local-inference/src/services/mlx-server.test.ts`: 8 `@ts-expect-error`.
- `plugins/plugin-local-inference/src/routes/local-inference-compat-routes.ts`: 15 catch fallback returns.
- `plugins/plugin-local-inference/src/services/dflash-server.ts`: 11 catch fallback returns.
- `plugins/plugin-local-inference/src/services/dflash-server.test.ts`: 10 double casts.
- `plugins/plugin-local-inference/native/verify/tts_step_sweep.mjs`: 8 empty catches.
- `plugins/plugin-local-inference/biome.json`: `noExplicitAny=off`.

### TODO LINF-1: Replace MLX private-state test suppressions

- Real fix: add a typed test seam/helper for route state or assert through public API. If private access is genuinely required, keep targeted `@ts-expect-error` with a reason on each line.
- Validation:

```sh
bun test plugins/plugin-local-inference/src/services/mlx-server.test.ts
rg -n '@ts-expect-error|@ts-ignore' plugins/plugin-local-inference/src/services/mlx-server.test.ts
```

### TODO LINF-2: Preserve inference/native route errors

- Target: compatibility routes, dflash server, native verify scripts.
- Real fix: return typed provider/native error states; only return empty/default values for documented optional features.
- Validation:

```sh
bunx tsc -p plugins/plugin-local-inference/tsconfig.json --noEmit
bun test plugins/plugin-local-inference/src/services
rg -n 'catch\\s*(\\([^)]*\\))?\\s*\\{[\\s\\S]{0,240}?return\\s+(null|undefined|false|true|\\[\\]|\\{\\})|catch\\s*(\\([^)]*\\))?\\s*\\{\\s*\\}' plugins/plugin-local-inference/src plugins/plugin-local-inference/native/verify
```

## `plugins/plugin-computeruse` P1

Hotspots:

- `plugins/plugin-computeruse/src/routes/sandbox-routes.ts`: 24 catch fallback returns.
- `plugins/plugin-computeruse/src/osworld/action-converter.ts`: 11 non-null assertions.
- `plugins/plugin-computeruse/src/platform/windows-list.ts`: 8 non-null assertions.
- `plugins/plugin-computeruse/src/platform/driver.ts`: 2 `eslint-disable` for console.

### TODO CU-1: Type sandbox route outcomes

- Real fix: represent sandbox unavailable, invalid session, command failure, and timeout as separate typed responses.
- Validation:

```sh
bunx tsc -p plugins/plugin-computeruse/tsconfig.json --noEmit
bun test plugins/plugin-computeruse
rg -n 'catch\\s*(\\([^)]*\\))?\\s*\\{[\\s\\S]{0,240}?return\\s+(null|undefined|false|true|\\[\\]|\\{\\})' plugins/plugin-computeruse/src/routes/sandbox-routes.ts
```

### TODO CU-2: Guard platform conversion assumptions

- Target: `osworld/action-converter.ts`, `platform/windows-list.ts`.
- Real fix: replace non-null assertions with validation that returns typed conversion errors.
- Validation:

```sh
rg -n '!\\s*(\\.|\\[|;|,|\\)|\\})' plugins/plugin-computeruse/src/osworld plugins/plugin-computeruse/src/platform
bun test plugins/plugin-computeruse/src
```

## Orchestration, Streaming, and Training P1

Packages: `plugins/plugin-agent-orchestrator`, `plugins/plugin-streaming`, `plugins/app-training`, `plugins/plugin-workflow`.

Hotspots:

- `plugins/plugin-agent-orchestrator/src/api/agent-routes.ts`: 14 catch fallback returns.
- `plugins/plugin-agent-orchestrator/src/services/task-registry.ts`: 17 empty object fallbacks.
- `plugins/plugin-agent-orchestrator/src/services/ansi-utils.ts`: 6 Biome suppressions for control regex.
- `plugins/plugin-streaming/src/api/stream-routes.ts`: 13 catch fallback returns.
- `plugins/app-training/src/routes/training-routes.ts`: 12 catch fallback returns.
- `plugins/app-training/src/routes/trajectory-routes.ts`: 13 empty array fallbacks, 8 empty object fallbacks.
- `plugins/plugin-workflow/src/services/embedded-workflow-service.ts`: 15 empty array fallbacks, 7 empty object fallbacks.

### TODO ORCH-1: Type task and workflow registry defaults

- Real fix: replace `{}` defaults in task/workflow registries with explicit `MissingTaskDefinition`, `NoRegisteredHandler`, or typed empty registry values.
- Validation:

```sh
bunx tsc -p plugins/plugin-agent-orchestrator/tsconfig.json --noEmit
bunx tsc -p plugins/plugin-workflow/tsconfig.json --noEmit
bun test plugins/plugin-agent-orchestrator
bun test plugins/plugin-workflow
```

### TODO ORCH-2: Replace route fallback returns

- Target: agent routes, workspace routes, stream routes, training routes, trajectory routes.
- Real fix: return status-coded route errors and preserve service failure causes.
- Validation:

```sh
rg -n 'catch\\s*(\\([^)]*\\))?\\s*\\{[\\s\\S]{0,240}?return\\s+(null|undefined|false|true|\\[\\]|\\{\\})' plugins/plugin-agent-orchestrator/src plugins/plugin-streaming/src plugins/app-training/src plugins/plugin-workflow/src
bun test plugins/plugin-streaming
bun test plugins/app-training
```

### TODO ORCH-3: Keep ANSI regex suppressions narrow

- Target: `plugins/plugin-agent-orchestrator/src/services/ansi-utils.ts`.
- Real fix: centralize ANSI regex constants and keep one documented suppression per intentional control-regex block.
- Validation:

```sh
bunx @biomejs/biome check plugins/plugin-agent-orchestrator/src/services/ansi-utils.ts
```

## `plugins/plugin-wallet` P1

Hotspots:

- `plugins/plugin-wallet/src/analytics/lpinfo/steer/services/steerLiquidityService.ts`: 12 catch fallback returns, 4 double casts.
- `plugins/plugin-wallet/src/analytics/lpinfo/kamino/services/kaminoLiquidityService.ts`: 11 catch fallback returns.
- `plugins/plugin-wallet/src/chains/solana/service.ts`: 5 catch fallback returns.
- `plugins/plugin-wallet/src/browser-shim/shim.template.js`: file-wide `eslint-disable`, `biome-ignore-all`, 9 empty catches.
- Chain configs under EVM/Solana use `strict=false` and `noImplicitAny=false`.

### TODO WALLET-1: Replace analytics/provider fallback returns

- Real fix: external provider errors should be represented as partial analytics results with provider error metadata, not silent empty data.
- Validation:

```sh
bunx tsc -p plugins/plugin-wallet/tsconfig.json --noEmit
bun test plugins/plugin-wallet
rg -n 'catch\\s*(\\([^)]*\\))?\\s*\\{[\\s\\S]{0,240}?return\\s+(null|undefined|false|true|\\[\\]|\\{\\})|as\\s+unknown\\s+as|as\\s+any\\s+as' plugins/plugin-wallet/src
```

### TODO WALLET-2: Isolate browser shim suppressions

- Real fix: move compatibility-only shim code behind a generated/fixture boundary or add targeted local suppressions with reasons. Do not keep bare file-wide disable if the file is edited by hand.
- Validation:

```sh
bunx @biomejs/biome check plugins/plugin-wallet/src/browser-shim/shim.template.js
rg -n 'eslint-disable|biome-ignore|catch\\s*(\\([^)]*\\))?\\s*\\{\\s*\\}' plugins/plugin-wallet/src/browser-shim/shim.template.js
```

## `packages/shared` P1

Hotspots:

- `packages/shared/src/utils/browser-tabs-renderer-registry.ts`: 20 empty catches, 4 empty object fallbacks.
- `packages/shared/src/contracts/lifeops.ts`: 72 `unknown`.
- `packages/shared/src/config/config-catalog.ts`: empty object fallbacks.
- `packages/shared/src/utils/assistant-text.ts`: Biome control-character regex suppression.

### TODO SHARED-1: Fix browser tab registry swallowed errors

- Real fix: convert empty catches to debug logging or typed result failures. If a best-effort cleanup failure is intentionally ignored, document the exact browser/runtime condition.
- Validation:

```sh
bunx tsc -p packages/shared/tsconfig.json --noEmit
bun test packages/shared
rg -n 'catch\\s*(\\([^)]*\\))?\\s*\\{\\s*\\}|\\?\\?\\s*\\{\\}|\\|\\|\\s*\\{\\}' packages/shared/src/utils/browser-tabs-renderer-registry.ts
```

### TODO SHARED-2: Verify LifeOps contract narrowing

- Target: `packages/shared/src/contracts/lifeops.ts`.
- Real fix: keep `unknown` contract payloads only if all consumers narrow structurally before behavior.
- Validation:

```sh
rg -n 'unknown' packages/shared/src/contracts/lifeops.ts plugins/app-lifeops/src plugins/plugin-health/src
bunx tsc -p packages/shared/tsconfig.json --noEmit
```

## Tests and Benchmarks P2

Packages: `cloud/packages/tests`, `packages/benchmarks`, selected app/plugin tests.

Hotspots:

- `cloud/packages/tests/unit/steward-sync.test.ts`: 34 double casts.
- `cloud/packages/tests/integration/services/agent-budgets.service.test.ts`: 58 non-null assertions.
- `cloud/packages/tests/integration/services/redeemable-earnings.service.test.ts`: 44 non-null assertions.
- `cloud/packages/tests/unit/eliza-app/cross-platform-linking.test.ts`: 34 non-null assertions.
- `packages/benchmarks/skillsbench/experiments/metrics-dashboard/server/index.ts`: 12 explicit `any`, 12 empty catches.
- `packages/benchmarks/configbench/src/handlers/eliza.ts`: 3 `eslint-disable`, 1 `biome-ignore`.

### TODO TEST-1: Add typed fixture builders for cloud tests

- Real fix: create builders that return non-null users/orgs/agents/budgets and expose typed IDs. Replace `!` and double casts at call sites.
- Validation:

```sh
bun test cloud/packages/tests/unit/steward-sync.test.ts
bun test cloud/packages/tests/integration/services/agent-budgets.service.test.ts
bun test cloud/packages/tests/integration/services/redeemable-earnings.service.test.ts
rg -n 'as\\s+unknown\\s+as|as\\s+any\\s+as|!\\s*(\\.|\\[|;|,|\\)|\\})' cloud/packages/tests
```

### TODO TEST-2: Type benchmark dashboard/tooling payloads

- Real fix: define benchmark metric/job DTOs and add debug logging for swallowed optional file/process cleanup failures.
- Validation:

```sh
bunx tsc -p packages/benchmarks/skillsbench/experiments/metrics-dashboard/tsconfig.json --noEmit
bun test packages/benchmarks
```

## Config and Template Ratchets P2

### TODO CFG-1: Biome `noExplicitAny`/`noNonNullAssertion` ratchet

- First wave: change package-level `off` to `warn` only after local source hotspots are addressed.
- Targets:
  - `cloud/biome.json`
  - `plugins/plugin-social-alpha/biome.json`
  - `plugins/plugin-local-inference/biome.json`
  - `plugins/plugin-app-control/biome.json`
  - `plugins/plugin-bluebubbles/biome.json`
  - `plugins/plugin-bluesky/biome.json`
  - `plugins/plugin-capacitor-bridge/biome.json`
  - `plugins/plugin-cli/biome.json`
  - `plugins/plugin-commands/biome.json`
  - `plugins/plugin-discord-local/biome.json`
  - `plugins/plugin-discord/biome.json`
  - `plugins/plugin-whatsapp/biome.json`
  - provider/plugin configs with `noUnusedVariables=off` or `noNonNullAssertion=off`
- Validation:

```sh
bunx @biomejs/biome check cloud packages plugins
rg -n 'noExplicitAny\"\\s*:\\s*\"off\"|noNonNullAssertion\"\\s*:\\s*\"off\"|noUnusedVariables\"\\s*:\\s*\"off\"' --glob 'biome.json' .
```

### TODO CFG-2: TypeScript strictness ratchet

- First wave targets:
  - `packages/agent/tsconfig.json`
  - `cloud/services/operator/tsconfig.json`
  - `packages/app-core/tsconfig.typecheck.json`
  - `plugins/app-messages/tsconfig.json`
  - `plugins/app-training/tsconfig.json`
  - provider plugins with `strict=false`
  - wallet chain configs with `strict=false` and `noImplicitAny=false`
- Real fix: create package-local strict overlay or flip one strict flag at a time. Prefer `strictNullChecks` and `noImplicitAny` before full strict if blast radius is large.
- Validation:

```sh
rg -n 'strict\"\\s*:\\s*false|noImplicitAny\"\\s*:\\s*false|noEmitOnError\"\\s*:\\s*false' --glob 'tsconfig*.json' packages plugins cloud
bunx tsc -p <target-tsconfig> --noEmit
```

### TODO CFG-3: Fix suspicious exclude globs

- Targets:
  - configs with `***`, `src__tests__`, `dist__tests__`, or `node_modulesdist`;
  - `plugins/plugin-coding-tools/tsconfig.build.json`;
  - `plugins/plugin-device-filesystem/tsconfig.build.json`;
  - `plugins/plugin-todos/tsconfig.build.json`.
- Real fix: replace with explicit TypeScript glob patterns and verify the config includes the intended files.
- Validation:

```sh
rg -n '\"\\*\\*\\*|src__tests__|dist__tests__|node_modulesdist' --glob 'tsconfig*.json' .
bunx tsc -p <target-tsconfig> --listFilesOnly
```

### TODO CFG-4: Remove non-blocking lint scripts where packages are owned source

- Targets:
  - `packages/examples/code/package.json`
  - `packages/examples/elizagotchi/package.json`
  - `packages/examples/moltbook/package.json`
  - `plugins/plugin-social-alpha/package.json`
- Real fix: make checks pass or mark package explicitly non-blocking in CI orchestration, not with `|| true` inside the package script.
- Validation:

```sh
rg -n '\\|\\|\\s*true|Format check skipped' --glob 'package.json' packages plugins cloud
bun run lint:check
```

## Done Criteria

- Active source `@ts-ignore`: 0.
- Active source `@ts-expect-error`: only targeted tests with reasoned directives.
- New `eslint-disable`/`biome-ignore`: rule-specific, line-local, reasoned, and guarded by inventory script.
- Explicit `any`: reduced first in `plugins/plugin-social-alpha`, route/API clients, production cloud/core paths, then tests.
- Double casts: removed from production paths; test double casts replaced by fixture builders.
- Non-null assertions: production service/API assertions replaced by guards; tests use non-null typed fixtures.
- Catch fallback returns: route/service fallbacks converted to typed errors or explicitly modeled optional-empty states.
- Empty array/object fallbacks: preserved only when the domain allows empty as a real value.
- Package configs: no package-level `noExplicitAny=off` or `noNonNullAssertion=off` remains for owned runtime source without a documented ratchet issue.

