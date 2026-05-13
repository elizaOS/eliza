# Suppressions, `any`, Assertions, and Fallbacks Audit

Date: 2026-05-12

Scope: searched TypeScript/TSX/JS/Svelte/CSS sources for `@ts-nocheck`,
`@ts-ignore`, `@ts-expect-error`, `eslint-disable`, `biome-ignore`,
oxlint/coverage ignores, explicit `any`, `unknown`, non-null assertions,
`??`, `||`, optional chaining, and broad `try/catch` fallbacks. Excluded
dependency, generated, vendor, build, dist, coverage, cache, and large benchmark
fixture trees.

Summary counts from the filtered scan:

- `@ts-*` directives: 11 matches, only 8 active `@ts-expect-error` suppressions
  in product-adjacent code; the other 3 are scanner/self-test text.
- lint/coverage suppressions: 191 matches.
- explicit `any`: 2,287 matches.
- non-null assertion-like matches: 1,219 matches.
- `unknown`, `??`, `||`, optional chaining, and `catch` are too common to treat
  mechanically; most are boundary parsing or normal defaults.

## True blockers

### 1. Streaming message route casts provider stream parts to `any`

- Ref: `cloud/apps/api/v1/messages/route.ts:996`
- Pattern: `result.fullStream as AsyncIterable<any>`
- Why it can mask bugs: the Anthropic-compatible streaming adapter switches on
  `part.type` and reads fields such as `part.id`, `part.text`, and
  `part.toolName`. A provider SDK shape change or a malformed stream part will
  compile and then silently produce malformed SSE, skipped blocks, or broken tool
  events.
- Risk: high. This is an API compatibility surface and bad stream normalization
  can affect all clients using `/v1/messages`.
- Likely fix strategy: define a local discriminated union for the stream part
  variants consumed here, add a small `normalizeFullStreamPart` guard, and route
  unknown part types to structured logging plus a safe stream error instead of
  falling through untyped.
- Validation: add unit coverage for text deltas, tool input start/delta/end,
  unknown stream part, and missing required fields; run the API route test suite
  and a streaming smoke request.

### 2. Pageview ingestion hides malformed JSON as an empty request

- Ref: `cloud/apps/api/v1/track/pageview/route.ts:36`
- Pattern: `await c.req.json().catch(() => ({}))`
- Why it can mask bugs: invalid JSON, wrong content type, truncated beacons, and
  client serialization bugs are indistinguishable from an intentionally empty
  body. Because `api_key` can be supplied in the body, this also changes auth
  behavior into a generic "missing app_id or valid API key" error.
- Risk: medium-high. It weakens observability on analytics ingestion and can
  hide client-side regressions.
- Likely fix strategy: accept empty body only for explicit empty/no-body
  requests; for malformed non-empty JSON return `400` with a parse error code.
  For `sendBeacon`, document and test the accepted content type.
- Validation: route tests for empty body, malformed JSON, valid body with body
  API key, valid header API key, and invalid app id.

### 3. Generated public SDK route clients globally disable explicit-`any`

- Refs:
  - `cloud/packages/sdk/src/public-routes.ts:1`
  - `plugins/plugin-elizacloud/src/utils/cloud-sdk/public-routes.ts:1`
- Pattern: `/* eslint-disable @typescript-eslint/no-explicit-any */` in generated
  API client files.
- Why it can mask bugs: these files are generated, so the generated output itself
  is an acceptable boundary. The blocker is upstream: the generator emits an SDK
  that exposes untyped request/response bodies across public cloud routes. That
  allows endpoint drift to compile in consumers.
- Risk: high for SDK consumers, medium for repo-local code because the files are
  marked generated and should not be hand-edited.
- Likely fix strategy: update `cloud/packages/sdk/scripts/generate-public-routes.mjs`
  and `cloud/apps/api/src/_generate-router.mjs` to emit `unknown` at the raw
  network boundary, endpoint-specific request types where route metadata exists,
  and narrow response wrappers instead of `any`.
- Validation: regenerate the SDK/router, run typecheck for cloud SDK consumers,
  and add a generator snapshot that fails on newly emitted `any`.

### 4. Cloud service startup still depends on non-null env assertions after validation

- Refs:
  - `cloud/services/agent-server/src/index.ts:52`
  - `cloud/services/agent-server/src/redis.ts:12`
  - `cloud/services/agent-server/src/agent-manager.ts:131`
- Pattern: `process.env.*!`
- Why it can mask bugs: `index.ts` validates required env vars, but lower-level
  modules still rely on ambient global state and non-null assertions. Tests or
  future imports that bypass the entrypoint can instantiate Redis or publish
  server state with a missing env var and fail late with less context.
- Risk: medium. The entrypoint guard reduces production blast radius, but module
  reuse remains brittle.
- Likely fix strategy: centralize validated config in a typed object and inject it
  into Redis/manager code. Keep process-env reads at the process boundary.
- Validation: unit tests for missing `REDIS_URL`, `SERVER_NAME`, and
  `AGENT_SERVER_SHARED_SECRET`; startup smoke with all required env vars.

### 5. UI context memo suppressions can hide stale context values

- Ref: `packages/ui/src/state/AppContext.tsx:2008`
- Pattern: exhaustive-deps disable on the central `AppContextValue` memo.
- Why it can mask bugs: the comment says the dependency array must stay in sync
  with the value object, but the lint rule is disabled on a very large provider.
  New fields can be added to the value without updating deps, causing stale UI
  state with no compile or lint signal.
- Risk: medium-high. The provider fans out to much of the desktop UI.
- Likely fix strategy: split the provider further into smaller context values,
  or construct sub-objects with their own complete dependency arrays so the final
  value memo can be lint-clean.
- Validation: React tests for recently added context fields, plus an eslint/biome
  pass with no blanket hook suppression on this memo.

## Acceptable boundaries

### Test-only private-field access

- Ref: `packages/app-core/src/services/local-inference/mlx-server.test.ts:164`
  through `packages/app-core/src/services/local-inference/mlx-server.test.ts:206`
- Pattern: eight `@ts-expect-error` directives used to attach a mock HTTP server
  to private route state.
- Classification: acceptable for now. The directives are in tests, are
  expectation-based rather than `@ts-ignore`, and are localized.
- Better long-term fix: expose a test seam or protected constructor hook for
  route/health state so tests stop mutating private fields.
- Validation: current local-inference test suite should keep covering the same
  generate/SSE behavior.

### Boundary parsing with `unknown`

- Examples:
  - `packages/vault/src/store.ts:40`
  - `plugins/app-training/src/routes/training-routes.ts:716`
  - `cloud/apps/api/v1/messages/route.ts:458`
- Classification: acceptable when immediately narrowed by schema/record guards.
  `unknown` is preferred over `any` at JSON, request-body, settings, and
  provider-response boundaries.
- Watch item: avoid `unknown as Record<string, unknown>` without an `isRecord`
  check in security-sensitive paths.

### Generated route maps and compatibility shims

- Refs:
  - `cloud/apps/api/src/_router.generated.ts:8`
  - `cloud/apps/api/src/_generate-router.mjs:186`
  - `plugins/plugin-wallet/src/browser-shim/shim.template.js:1`
- Classification: acceptable when generated/template files clearly state their
  source and are regenerated, not hand-maintained.
- Required guardrail: generated files should be excluded from cleanup tickets but
  their generators should be linted and snapshot-tested.

### Narrow lint suppressions for platform/library constraints

- Examples:
  - `plugins/plugin-agent-orchestrator/src/services/ansi-utils.ts:11`
  - `packages/core/src/utils.ts:69`
  - `packages/core/src/services/hook.ts:167`
  - `packages/ui/src/styles/xterm.css:175`
- Classification: acceptable. These suppressions are narrow, justified, and
  tied to regex control characters, dynamic require boundaries, xterm styling, or
  other library interop constraints.
- Validation: keep comments specific; avoid file-wide disables unless generated.

### Definite assignment on lifecycle-initialized services

- Examples:
  - `packages/core/src/runtime.ts:694`
  - `packages/core/src/types/service.ts:142`
  - `plugins/plugin-elizacloud/src/services/cloud-container.ts:40`
- Classification: acceptable with caution. Service frameworks often initialize
  fields outside the constructor. This is less concerning than non-null
  assertions on request data or env vars.
- Better long-term fix: use constructors/factories for required dependencies, or
  represent pre-started vs started service states with types.

## Risk backlog

### Non-null assertions on request/database values

- Examples:
  - `cloud/packages/lib/services/seo.ts:553`
  - `cloud/packages/lib/services/memory.ts:217`
  - `cloud/packages/lib/services/proxy/services/solana-rpc.ts:457`
  - `cloud/packages/lib/services/social-media/providers/meta.ts:240`
- Risk: medium. Some are likely protected by prior guards, but these should be
  checked file by file because request and provider data can drift.
- Fix strategy: replace with local `assertPresent`/`requireField` helpers that
  throw typed errors carrying the field name and operation.
- Validation: unit tests for missing field paths and provider error responses.

### Fallbacks that may collapse distinct states

- Examples:
  - `cloud/apps/api/v1/track/pageview/route.ts:83`
  - `plugins/app-elizamaker/src/drop-routes.ts:91`
  - `packages/agent/src/services/app-manager.ts:1218`
  - `packages/vault/src/vault.ts:46`
- Risk: low to medium depending on domain. Defaults like display names and local
  state dirs are normal; defaults on auth, routing, billing, analytics, and task
  execution deserve explicit validation.
- Fix strategy: classify fallbacks as "presentation default", "config default",
  or "behavior default"; require tests for behavior defaults.
- Validation: targeted tests that distinguish missing, empty string, zero, false,
  and malformed values.

### Hook dependency suppressions

- Examples:
  - `packages/ui/src/hooks/useFetchData.ts:100`
  - `packages/ui/src/components/character/CharacterEditor.tsx:764`
  - `packages/ui/src/state/useChatSend.ts:956`
  - `packages/ui/src/components/pages/AppsView.tsx:836`
- Risk: medium. Some are well documented and use refs intentionally, but stale
  closures are easy to reintroduce during UI changes.
- Fix strategy: prefer `useEvent`/stable callback helpers or split effects until
  the dependency list is lint-clean. Where a suppression remains, include the
  invariant in a nearby test.
- Validation: React tests for changed callback props and identity changes.

### `any` in tests and fixtures

- Examples:
  - `packages/vault/test/vitest-assertion-shim.ts:7`
  - `packages/agent/src/services/shell-execution-router.test.ts:93`
  - `packages/app-core/src/benchmark/__tests__/server-role-seeding.test.ts:177`
- Risk: low. These are isolated test fakes or framework augmentation.
- Fix strategy: leave unless they leak into exported helpers; prefer minimal
  structural test types for shared fixtures.
- Validation: typecheck tests and ensure no `any` leaks from test support exports.

## Prioritized TODOs

1. Replace `AsyncIterable<any>` in `cloud/apps/api/v1/messages/route.ts` with a
   typed stream-part normalizer and tests for malformed provider chunks.
2. Stop swallowing malformed pageview JSON in
   `cloud/apps/api/v1/track/pageview/route.ts`; add explicit empty-body vs
   invalid-body tests.
3. Change public-route generators so generated SDK/router output does not need
   global explicit-`any` disables; add a snapshot/grep guard against new emitted
   `any`.
4. Move agent-server env reads into a typed validated config object and inject it
   into Redis/manager code.
5. Break up or rework `packages/ui/src/state/AppContext.tsx` so the central value
   memo no longer requires an exhaustive-deps suppression.
6. Add a repo cleanup guard that fails on new `@ts-ignore`, file-wide
   `eslint-disable`, and unannotated `biome-ignore`; allow generated files and
   documented test-only `@ts-expect-error`.
7. Create a smaller follow-up audit for non-null assertions in `cloud/packages`
   request/provider/database paths, replacing risky `!` with typed field
   assertions.
8. Document acceptable fallback categories in contributor guidance: presentation
   defaults are fine; behavior, auth, billing, routing, and persistence defaults
   need validation and tests.
