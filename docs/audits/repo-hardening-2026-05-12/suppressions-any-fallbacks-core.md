# Suppressions, Type Escapes, and Fallback Hardening: Core-Facing Packages

Date: 2026-05-12

Scope:

- `packages/core`
- `packages/agent`
- `packages/app-core`
- `packages/shared`
- `packages/ui`
- `packages/app`
- `packages/vault`
- `packages/elizaos`
- `cloud/packages/sdk`
- `packages/cloud-routing`

Exclusions used for search: `node_modules/**`, `dist/**`, `docs/audits/**`. The scan used TypeScript/TSX sources and included tests so test-only suppressions can be separated from production findings.

## Method

Primary search commands:

```sh
rg -n --hidden --glob '!node_modules/**' --glob '!dist/**' --glob '!docs/audits/**' --glob '!**/*.d.ts' --glob '*.ts' --glob '*.tsx' '@ts-nocheck|@ts-ignore|@ts-expect-error|eslint-disable|biome-ignore' packages/core packages/agent packages/app-core packages/shared packages/ui packages/app packages/vault packages/elizaos cloud/packages/sdk packages/cloud-routing
rg -n --hidden --glob '!node_modules/**' --glob '!dist/**' --glob '!docs/audits/**' --glob '!**/*.d.ts' --glob '*.ts' --glob '*.tsx' '\bas\s+any\b|:\s*any\b|<any>|\bunknown\b|!\.|!\)|!\]|\?\.|\?\?|\|\||catch\s*(\([^)]*\))?\s*\{' packages/core packages/agent packages/app-core packages/shared packages/ui packages/app packages/vault packages/elizaos cloud/packages/sdk packages/cloud-routing
```

Package typecheck commands from `package.json`:

- `packages/core`: `tsc --noEmit -p ./tsconfig.json`
- `packages/agent`: `tsc --noEmit -p tsconfig.json`
- `packages/app-core`: `tsc --noEmit -p tsconfig.json`
- `packages/shared`: `tsc --noEmit -p tsconfig.json`
- `packages/ui`: `tsc --noEmit -p tsconfig.json`
- `packages/app`: `tsc --noEmit -p tsconfig.typecheck.json`
- `packages/vault`: `tsc --noEmit -p tsconfig.json`
- `packages/elizaos`: `tsc --noEmit`
- `cloud/packages/sdk`: `tsc --noEmit`
- `packages/cloud-routing`: `tsc --noEmit -p tsconfig.json`

## Counts

These are raw `rg --count-matches` counts. They intentionally overcount benign optional chaining and `unknown` boundary types, so findings below classify what should be hardened.

| Package | TS files | suppressions | explicit `any` | `unknown` | non-null | `?.` | `??` | `||` | `catch` |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `packages/core` | 680 | 16 | 5 | 2152 | 4 | 3035 | 2738 | 2476 | 539 |
| `packages/agent` | 718 | 6 | 3 | 2383 | 0 | 2649 | 2398 | 1984 | 849 |
| `packages/app-core` | 514 | 37 | 9 | 1668 | 29 | 2255 | 2111 | 1574 | 811 |
| `packages/shared` | 187 | 1 | 0 | 470 | 0 | 284 | 145 | 257 | 72 |
| `packages/ui` | 730 | 51 | 0 | 1150 | 0 | 2371 | 2237 | 2209 | 801 |
| `packages/app` | 53 | 2 | 0 | 115 | 4 | 135 | 161 | 150 | 68 |
| `packages/vault` | 29 | 6 | 0 | 25 | 2 | 88 | 49 | 57 | 30 |
| `packages/elizaos` | 90 | 2 | 0 | 127 | 0 | 82 | 69 | 118 | 32 |
| `cloud/packages/sdk` | 9 | 1 | 0 in source text, generated file disables rule | 527 | 0 | 8 | 18 | 4 | 1 |
| `packages/cloud-routing` | 6 | 0 | 0 | 10 | 0 | 1 | 3 | 11 | 0 |

## Prioritized TODO

1. Must-fix: Replace production `@ts-expect-error` and generated `any` suppressions with narrow ambient types or generated `unknown`/generic request shapes.
2. Must-fix: Validate external JSON before using `as Array<...>` or `as Record<string, unknown>` in runtime code.
3. Must-fix: Replace silent catch-and-default paths for configuration, mobile bridge setup, local storage, and plugin discovery with typed result objects, structured warnings, or explicit "unavailable" states.
4. Must-fix: Replace identifier fallbacks like `id ?? ""`, boolean fallbacks like `allowed || false`, and numeric scoring fallbacks like `trust || 0` where absence should be distinct from a real empty/zero value.
5. Acceptable boundary: Keep `unknown` at API/runtime/plugin boundaries only when immediately narrowed by guards; otherwise move casts behind parse helpers.
6. Acceptable boundary: Keep test-only `@ts-expect-error` probes that deliberately exercise runtime guards, but document the pattern and fail tests if the guard is removed.

## `packages/core`

### Must-fix

- `packages/core/src/features/documents/url-ingest.ts:123` uses `@ts-expect-error` to return a Node `Readable.toWeb()` stream as `BodyInit`. Fix pattern: add a local helper type alias for the Node/web stream divergence, or convert through a `Response`/`Blob` path that TypeScript accepts. Validation: `bun run typecheck` in `packages/core` plus URL ingest tests.
- `packages/core/src/features/trust/services/db.ts:7-8` defines `DrizzleDB = Record<string, (...args: unknown[]) => any>`. This is a trust/security store boundary and should not leak `any` into callers. Fix pattern: model the small set of Drizzle methods used by trust services with `unknown` return plus local query helpers, or import the concrete Drizzle database type. Validation: `packages/core` typecheck and trust service tests.
- `packages/core/src/features/trust/services/ContextualPermissionSystem.ts:381-383` uses `partialDecision.allowed || false` and `partialDecision.reason || ""`. This collapses malformed/missing values with explicit false/empty decisions. Fix pattern: parse permission decisions with a schema and require `allowed` to be boolean; default only after validation fails with a logged reason. Validation: permission decision tests covering missing, false, and malformed responses.
- `packages/core/src/features/trust/types/permissions.ts:240,266,291` uses `(caller.trust || 0) >= 80`. This treats `NaN`, missing, and zero the same and can hide corrupted trust values. Fix pattern: normalize trust score with `Number.isFinite` and range validation. Validation: trust permission tests for absent, zero, NaN, and high trust.
- `packages/core/src/features/trust/services/SecurityModule.ts:815,817,818,1121,1125,1128,1139,1246` contains scoring/history fallbacks such as `similarities.typing || 0`, `messageHistory.get(...) || []`, and divide-by-empty fallback `... / length || 0`. Fix pattern: use explicit empty-list checks and finite-number validation before scoring. Validation: identity/security module tests for no-history and malformed metrics.
- `packages/core/src/features/advanced-capabilities/actions/message.ts:99` casts `(options?.parameters ?? {}) as ParamRecord`. This hides malformed action parameters in a high-volume action path. Fix pattern: introduce `parseMessageParams(options)` with field-level guards and return a typed result. Validation: message action tests for invalid parameter shapes.
- `packages/core/src/features/advanced-capabilities/actions/message.ts:1849` returns `params.sentMemory ?? undefined` after persistence failure paths. Fix pattern: separate "already sent" from "failed to persist" in a result type and surface persistence errors to caller/logs. Validation: connector action tests with simulated persistence failure.
- `packages/core/src/features/basic-capabilities/index.ts:334,337,674,746` uses LLM/attachment parsed JSON fallbacks like `parsedJson.description ?? ""` and `parsedJsonResponse.post ?? ""`. Fix pattern: validate structured model output and treat missing required fields as a failed extraction, not empty content. Validation: attachment and post evaluator tests with missing fields.
- `packages/core/src/features/plugin-manager/security.ts:75,96,117` catches plugin-manager authorization lookup failures and returns a fallback result. Fix pattern: return a typed denial result with reason `lookup_failed` and log the exception. Validation: plugin manager security tests for store failure.
- `packages/core/src/features/basic-capabilities/evaluators/link-extraction.ts:153` and `packages/core/src/media/fetch.ts:77,105,124,289,303` use defensive catches around URL/media parsing and fetch metadata. Some are boundary-acceptable, but the current pattern often converts errors to absent metadata. Fix pattern: return `Result<T, MediaFetchError>` internally and only downgrade at UI/provider formatting boundaries. Validation: link extraction/media fetch tests for invalid URL, unsupported MIME, and network failure.

### Acceptable boundary

- `packages/core/src/services/hook.ts:167`, `packages/core/src/streaming-context.ts:99,202`, `packages/core/src/runtime/action-routing-context.ts:55`, `packages/core/src/plugin-lifecycle.ts:142`, and `packages/core/src/trajectory-context.ts:67` suppress `no-require-imports` for runtime dynamic loading. Keep if the import target is genuinely optional or runtime-selected; prefer a common `loadOptionalCjs()` helper.
- `packages/core/src/utils.ts:69` suppresses `no-implied-eval` around dynamic evaluation. Keep only if all call sites are trusted; otherwise gate with an explicit "unsafe eval allowed" option and tests.
- `packages/core/src/types/service.ts:83` and `packages/core/src/types/messaging.ts:25` are type compatibility suppressions for module augmentation/legacy connector return types. Acceptable while these contracts remain frozen.
- Test-only suppressions at `packages/core/src/runtime/__tests__/model-input-budget.test.ts:210-211` and similar `as unknown as` test stubs are acceptable boundary probes.

## `packages/agent`

### Must-fix

- `packages/agent/src/services/agent-export.ts:657,671,689,722,742,760,761,778` remaps IDs with `remap(id ?? "") as UUID`. Empty-string UUIDs can silently corrupt imports/exports. Fix pattern: validate required IDs before remap and fail the export/import with a file/record-specific error. Validation: agent export/import tests with missing IDs.
- `packages/agent/src/api/agent-status-routes.ts:340,341,395,396` uses `body.endpoint || ""` and `body.tokenURI || ""` for registry/status requests. Fix pattern: parse request body with required non-empty strings and return 400 on invalid input. Validation: route tests for missing, empty, and malformed endpoint/token URI.
- `packages/agent/src/services/client-chat-sender.ts:91,105` sends `content.text ?? ""`. Empty text can hide bad message payloads. Fix pattern: distinguish absent text from intentional empty text and reject or log malformed outbound messages. Validation: chat sender tests for missing text.
- `packages/agent/src/services/research-task-executor.ts:40` uses `researchResult.text ?? ""`. Fix pattern: make research output schema require a text field or emit an explicit no-content result. Validation: executor test for missing text.
- `packages/agent/src/services/registry-client-app-meta.ts:113-114,182,185` defaults embed params/capabilities/launch URL from partial registry metadata. Fix pattern: centralize registry metadata parsing and preserve "field missing" diagnostics. Validation: registry client tests for partial/invalid app metadata.

### Acceptable boundary

- `packages/agent/src/runtime/web-search-tools.ts:167` suppresses `no-require-imports` for optional runtime loading. Acceptable if the import is unavailable in some runtimes; prefer a shared optional loader.
- `packages/agent/src/services/escalation.ts:342` suppresses static-only-class lint for a module-style service API. Acceptable design suppression.
- Test-only suppressions at `packages/agent/src/services/shell-execution-router.test.ts:93-94` and `packages/agent/src/runtime/conversation-compactor.test.ts:1103-1104` deliberately pass wrong types; acceptable if paired with runtime guard assertions.

## `packages/app-core`

### Must-fix

- `packages/app-core/src/services/discord-target-source.ts:92,120` casts Discord REST JSON directly to arrays. Bad API responses become normal empty/partial catalog facts. Fix pattern: validate guild/channel arrays with guards or a schema before mapping. Validation: tests with malformed guild/channel JSON and non-OK responses.
- `packages/app-core/src/services/discord-target-source.ts:93-101,132-140` catches Discord fetch/parse failures and returns `[]` or a per-guild error. Returning `[]` for the top-level guild call hides credential/network failures. Fix pattern: return `{ ok:false, reason }` and let callers decide whether to cache/display empty state. Validation: target-source tests for network failure and invalid token.
- `packages/app-core/src/api/database-rows-compat-routes.ts:109,114,153` uses parse fallbacks for `limit`, `offset`, and row count. Fix pattern: validate query params with min/max and reject invalid numbers with 400; validate count row shape. Validation: route tests for `limit=abc`, negative offsets, and missing count.
- `packages/app-core/src/services/sensitive-requests/public-link-adapter.ts:65,70,82,91` casts request targets and request kind/payment context. Because this governs payment links, make the `SensitiveRequestWithPaymentContext` shape explicit at the adapter boundary. Fix pattern: `parseAnyPayerPaymentRequest(request)` returning a discriminated result. Validation: sensitive-request tests for malformed target/callback/payment context.
- `packages/app-core/src/services/sensitive-requests/tunnel-link-adapter.ts:33-40` uses optional calls and `Boolean(status?.active ?? service.isActive?.())`. A malformed tunnel service can be treated as inactive instead of invalid. Fix pattern: validate tunnel service shape and return `adapter_unavailable` for bad service objects. Validation: tunnel adapter tests for bad service methods and missing URL.
- `packages/app-core/platforms/electrobun/src/index.ts:765,904,939` uses `@ts-expect-error` for Bun `duplex` and Electrobun `icon`. Fix pattern: add local ambient declaration/adapter types for Bun fetch init and Electrobun window options. Validation: `packages/app-core` typecheck.
- `packages/app-core/platforms/electrobun/src/index.ts:1296-1297` and `packages/app-core/platforms/electrobun/src/rpc-handlers.ts:142-145` use `any` in RPC handler maps. Fix pattern: define a typed `RpcMethodMap` with `unknown` params and method-specific narrowing at handlers. Validation: RPC schema/handler typecheck and smoke tests.
- `packages/app-core/platforms/electrobun/src/native/canvas.ts:86,429` uses `@ts-expect-error` for an untyped `partition` option. Fix pattern: local Electrobun type augmentation. Validation: Electrobun platform typecheck.
- `packages/app-core/src/services/steward-credentials.ts:97,102,108,110,114,115` chains env/persisted credential fallbacks with `||`. This makes empty persisted values and absent credentials indistinguishable. Fix pattern: parse credentials into a result with per-field source and missing/empty diagnostics. Validation: credential tests for empty env overriding persisted values.

### Acceptable boundary

- `packages/app-core/src/runtime/embedding-manager-support.ts:77` and `packages/app-core/src/services/local-inference/voice/ffi-bindings.ts:426` suppress `no-require-imports` for runtime/FFI loading. Acceptable optional native boundary.
- `packages/app-core/platforms/electrobun/src/rpc-schema.ts:1571` empty schema placeholder is acceptable if covered by schema evolution tests.
- Test/benchmark suppressions under `packages/app-core/test/**` and `packages/app-core/src/services/local-inference/**/*.test.ts` are acceptable when they exercise unsupported sources, synthetic manifests, conditional live tests, or external benchmark imports.

## `packages/shared`

### Must-fix

- `packages/shared/src/dev-settings-figlet-heading.ts:26,72` catches figlet/rendering failures and silently degrades. If this is developer-only UI, acceptable; if used in setup diagnostics, include a warning channel so a broken settings render is visible. Validation: dev settings rendering test for missing figlet font.
- `packages/shared/src/utils/browser-tabs-renderer-registry.ts:313,376,421,576,636,1059` uses `options || {}`, `params || []`, and wallet namespace fallbacks in browser automation shims. Fix pattern: normalize renderer command payloads with typed defaults and report malformed payloads. Validation: browser tabs renderer tests for empty params vs missing params.
- `packages/shared/src/i18n/keyword-matching.ts:149,158` defaults missing locale text to `""`. Fix pattern: distinguish missing locale from empty locale and optionally emit coverage diagnostics for generated keyword data. Validation: keyword matching tests for missing locale.

### Acceptable boundary

- `packages/shared/src/utils/assistant-text.ts:129` suppresses control-character regex lint to reject non-ASCII input. Acceptable.
- `packages/shared/src/runtime-env.ts:167,178,220,255,283,382` uses fallbacks for environment parsing. Acceptable boundary when paired with explicit normalization helpers; keep tests for invalid port/token/bind values.

## `packages/ui`

### Must-fix

- `packages/ui/src/widgets/registry.ts:257-258` uses a non-null assertion for chat-sidebar widget components. Fix pattern: filter to widgets with `Component` or throw a descriptive registry error including plugin/widget id. Validation: widget registry tests for missing bundled component.
- `packages/ui/src/onboarding/auto-download-recommended.ts:45,54,66,96,117` catches storage/download marker failures and continues silently. Fix pattern: return an explicit persistence/download status and expose non-blocking diagnostics. Validation: onboarding tests with throwing `localStorage` and rejected auto-download.
- `packages/ui/src/state/persistence.ts:25,125,139,152,166,201,217,351,370,548,582,608,636,659,851,892` uses catch-and-log/default behavior around persisted state and favorite apps. Fix pattern: consolidate persistence reads through `readPersisted<T>()` returning `{ ok, value, error }` so callers distinguish corrupted state from empty state. Validation: persistence tests for malformed JSON, storage exceptions, and API failures.
- `packages/ui/src/state/useChatSend.ts:392,581,619,773,833,885,1009,1141,1282,1322` catches send/stream/tool-call errors at many nested levels. Fix pattern: centralize send pipeline error classification and avoid swallowing per-step failures into generic UI state. Validation: chat send tests for stream abort, invalid JSON tool event, and persistence failure.
- `packages/ui/src/bridge/native-plugins.ts:23,637,644,665` returns `{}` as a generic native plugin fallback. This hides missing native plugins until method invocation. Fix pattern: return a proxy that reports `missing_plugin` with plugin name, or require `getRequiredPlugin(name)` for mandatory plugins. Validation: bridge tests for missing native plugins.
- `packages/ui/src/components/apps/per-app-config.ts:50,73,89` catches malformed per-app config and returns defaults. Fix pattern: preserve parse errors in launch diagnostics and only use defaults after recording corrupted config. Validation: per-app config tests for malformed JSON and invalid launch mode.
- `packages/ui/src/platform/desktop-permissions-client.ts:245,258,296,304` chains renderer, bridged, and original permission fallbacks. Fix pattern: return source-tagged permission state so caller can tell bridge unavailable from denied permission. Validation: desktop permission tests for bridge failure and explicit denial.

### Acceptable boundary

- `packages/ui/src/onboarding/__tests__/flow.test.ts:113,133,161,227,240,422,588,590,593,597,603` are negative runtime-guard probes. Acceptable.
- React hook dependency suppressions at `packages/ui/src/state/AppContext.tsx:1714,1717,1859`, `packages/ui/src/state/useChatSend.ts:976`, `packages/ui/src/state/useChatCallbacks.ts:481`, `packages/ui/src/components/pages/ElizaCloudDashboard.tsx:436`, `packages/ui/src/components/pages/WorkflowGraphViewer.tsx:686`, `packages/ui/src/components/character/CharacterEditor.tsx:769`, `packages/ui/src/components/apps/AppsView.tsx:836`, and `packages/ui/src/components/composites/chat/chat-composer.tsx:242` are acceptable only with regression tests around stale closures and rerender behavior. The most fragile are `AppContext` and `useChatSend`.
- A11y/no-array-index-key suppressions in view-only graph/config/media/game components are acceptable when controls are programmatically associated or index is only a tiebreaker. Revisit `CharacterEditorPanels.tsx:436,442,602` because comments say items lack stable keys.

## `packages/app`

### Must-fix

- `packages/app/src/main.tsx:162-164` accepts any array as a share-target queue. Fix pattern: validate `ShareTargetPayload` entries field-by-field. Validation: boot tests with malformed injected share queue.
- `packages/app/src/main.tsx:184` uses `import.meta.env.DEV ?? false`; `DEV` should be boolean. Fix pattern: avoid fallback and let typecheck enforce Vite env shape. Validation: app typecheck.
- `packages/app/src/main.tsx:219-223,588-590,874-878,887-889,925-1017` catches boot/mobile bridge/config errors and often returns `false`, `null`, or `undefined`. Fix pattern: add boot diagnostics with source-tagged errors and fail clearly for required native capabilities. Validation: mobile boot smoke tests and unit tests for invalid gateway/device bridge URL.
- `packages/app/src/main.tsx:595-597` uses `?.trim() || undefined` for share title/text/url. Empty values may be fine, but malformed URLs should be validated before queuing. Validation: share intent tests.
- `packages/app/src/main.tsx:851-852` falls back from `crypto.randomUUID()` to `Date.now()+Math.random()`. Fix pattern: use `crypto.getRandomValues` fallback or fail when cryptographic randomness is unavailable. Validation: device bridge ID test with `randomUUID` absent.
- `packages/app/src/app-config.ts:8,10` falls back from branded namespace/urlScheme to CLI name. Fix pattern: validate `app.config` at import time so missing namespace/scheme is explicit. Validation: app config tests.
- `packages/app/vite/native-module-stub-plugin.ts:34,106` catches dynamic require/serialization failures while generating stubs. Fix pattern: emit build warnings with module id and preserve failed module diagnostics. Validation: Vite plugin tests for missing optional native modules.

### Acceptable boundary

- `packages/app/vite/native-module-stub-plugin.ts:29,83` suppresses `no-require-imports` for Vite build-time resolution. Acceptable boundary.
- `packages/app/test/ui-smoke/apps-utility-interactions.spec.ts:206-207` non-null assertions on Playwright locator boxes are test-only; acceptable if the test asserts presence immediately before use.

## `packages/vault`

### Must-fix

- `packages/vault/src/inventory.ts:129` uses `m[1]!` after a regex match. This is currently safe for the exact regex, but should use named capture or destructuring guard to avoid future regex drift. Validation: provider inference tests.
- `packages/vault/src/inventory.ts:190-191` uses `PROVIDER_LABELS[providerId]!` after a truthy lookup. Fix pattern: store lookup in a local variable and return it after narrowing. Validation: typecheck.
- `packages/vault/src/audit.ts:18,23-25` defaults missing audit timestamp to `Date.now()` and only warns on write failure. Fix pattern: require timestamp at call sites or tag generated timestamps as `recordedAt`; return write result for critical audit paths. Validation: audit tests for missing timestamp and write failure.
- `packages/vault/src/store.ts:34-65` catches read/parse/rename failures and repairs/quarantines state. This is generally good, but parse failures should include enough diagnostic context and avoid overwriting without backup. Validation: store corruption tests verify backup/quarantine.
- `packages/vault/src/external-credentials.ts:156,157,289` defaults missing imported usernames/passwords to `""`. Fix pattern: reject credential records missing required secret material and record skipped item diagnostics. Validation: import tests for missing password/username.

### Acceptable boundary

- Test-only `@ts-expect-error` at `packages/vault/test/master-key.test.ts:87`, `packages/vault/test/vault.test.ts:61,68,176`, and `packages/vault/test/pglite-vault.test.ts:135` intentionally exercise runtime validation. Acceptable.
- `packages/vault/test/vitest-assertion-shim.ts:4` is a test framework generic compatibility suppression. Acceptable.

## `packages/elizaos`

### Must-fix

- `packages/elizaos/src/commands/plugins.ts:192-204` uses optional chaining and `||` to derive package/repository metadata. Fix pattern: parse `package.json` with a schema and emit field-specific errors. Validation: plugin publish tests for missing name, invalid repository object, and homepage-only metadata.
- `packages/elizaos/src/commands/plugins.ts:275` returns `repository.url || null`. Fix pattern: require non-empty URL after trimming and include repository type in validation errors. Validation: repository value tests.
- `packages/elizaos/src/commands/plugins.ts:285` catches URL parsing and returns null. Fix pattern: return a typed parse error so callers can distinguish absent repo from invalid repo. Validation: invalid GitHub URL tests.
- `packages/elizaos/src/commands/plugins.ts:334,367-368` uses stdout/stderr fallback strings for command errors. Acceptable for CLI display, but should preserve exit code and command metadata in an error type. Validation: command-runner tests.
- `packages/elizaos/src/scaffold.ts:382,413,553,591` uses env/template fallbacks. Fix pattern: validate template manifest/upstream config once and pass a normalized object through scaffolding. Validation: scaffold tests for missing upstream branch/repo and malformed template JSON.

### Acceptable boundary

- `packages/elizaos/templates/project/apps/app/vite.config.ts:588,642` suppresses build-time `require` in generated template config. Acceptable if template typecheck/lint still runs after generation.

## `cloud/packages/sdk`

### Must-fix

- `cloud/packages/sdk/src/public-routes.ts:1` disables `@typescript-eslint/no-explicit-any` for the whole generated public route client. Fix pattern: update `cloud/packages/sdk/scripts/generate-public-routes.mjs:155` to generate `unknown` request/response shapes or route-specific generics instead of `any`, then regenerate. Validation: `bun run check:routes`, SDK typecheck, SDK tests.
- `cloud/packages/sdk/src/client.ts:324,487,505,514,562,573,645,677,681,687,697,706,716,725` exposes `unknown`/`Record<string, unknown>` for public SDK request/response surfaces. Some are acceptable where cloud API schemas are not local, but public SDK methods should prefer exported DTOs. Fix pattern: introduce DTO types generated from API route metadata or OpenAPI and keep `unknown` only for truly schema-less workflow payloads. Validation: SDK public API type tests.
- `cloud/packages/sdk/src/client.ts:117` falls back when `crypto.randomUUID` is absent. Ensure the fallback is cryptographically strong or fail. Validation: client request-id tests with mocked crypto.

### Acceptable boundary

- The generated endpoint table in `src/public-routes.ts` is an acceptable generated boundary if the generator enforces stable method names and route audit passes.
- Workflow methods returning `Promise<unknown>` at `cloud/packages/sdk/src/client.ts:677-725` are acceptable temporarily because the comment says local OpenAPI types were missing; track as a schema debt item.

## `packages/cloud-routing`

### Must-fix

- `packages/cloud-routing/src/features.ts:85` casts `id as Feature` before map lookup and returns `null` for unknown ids. This is acceptable for lookup, but callers that route execution should validate with `isFeature` first and surface unknown feature IDs. Validation: route resolution tests for unknown feature IDs.
- `packages/cloud-routing/src/resolve.ts:83` falls back from configured cloud base URL to default URL. Fix pattern: keep fallback for hosted defaults, but add diagnostics when an invalid or absent configured value causes fallback. Validation: resolve tests for invalid URL and missing setting.
- `packages/cloud-routing/src/resolve.ts:240` accepts `policyOverride ?? getFeaturePolicy(...)`. Fix pattern: validate overrides at CLI/API boundary and reject invalid policies before resolve. Validation: policy override tests.

### Acceptable boundary

- `packages/cloud-routing/src/resolve.ts:25-45` intentionally narrows `IAgentRuntime#getSetting` to primitive values. The `unknown` boundary is acceptable because it validates return primitives.
- `packages/cloud-routing/src/resolve.ts:171` documents defaulting unknown features to `auto`; acceptable if this package remains a resolver and not an authorization gate.

## Cross-Cutting Fix Patterns

- Replace `as Record<string, unknown>` at runtime boundaries with named parse helpers: `parseX(value): X | ParseError`.
- Replace `@ts-expect-error` for third-party type drift with local module augmentation files. This keeps the mismatch visible to typecheck without suppressing the call site.
- Replace `foo || default` with `foo ?? default` only when empty string/zero/false are valid values. When the value is required, validate and fail early instead of defaulting.
- Replace catch-and-default with `Result` objects inside core services, and downgrade to empty UI state only at display boundaries.
- For external JSON, never cast `await response.json()` directly to the target type. Decode it first, even with lightweight guards.
- For public SDK/client APIs, export DTOs or generics. Keep `unknown` at schema-less extension points only.

## Validation Matrix

Run after hardening changes:

```sh
(cd packages/core && bun run typecheck && bun run test)
(cd packages/agent && bun run typecheck && bun run test)
(cd packages/app-core && bun run typecheck && bun run test)
(cd packages/shared && bun run typecheck && bun run test)
(cd packages/ui && bun run typecheck && bun run test)
(cd packages/app && bun run typecheck && bun run test)
(cd packages/vault && bun run typecheck && bun run test)
(cd packages/elizaos && bun run typecheck && bun run test)
(cd cloud/packages/sdk && bun run check:routes && bun run typecheck && bun run test)
(cd packages/cloud-routing && bun run typecheck && bun run test)
```

Targeted tests to add or expand:

- malformed external JSON for Discord, registry metadata, cloud SDK responses, and LLM structured outputs
- missing IDs in agent export/import records
- corrupted browser/mobile persisted state
- missing native plugins and unavailable bridge methods
- invalid payment/tunnel sensitive-request shapes
- trust/security scoring with missing, false, zero, and malformed values
