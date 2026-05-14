# Runtime/domain cleanup TODOs

Date: 2026-05-13

Scope requested:

- `packages/core`
- `packages/agent`
- `packages/server`
- `packages/shared`
- `plugins/plugin-local-inference` contracts
- duplicate/shared types
- shims/re-exports
- defensive fallback cleanup
- validation

Important scope note: `packages/server` does not exist in this checkout. The current server surface lives primarily under `packages/agent/src/api`, especially `packages/agent/src/api/server.ts`, `packages/agent/src/api/chat-routes.ts`, and route modules mounted from there.

Do not delete anything as part of these TODOs until the validation gates for that section pass and the cleanup owner explicitly approves removal. Prefer adding snapshots, moving callers, and marking deprecations first.

## Sequencing

1. Baseline current behavior and exports.
2. Lock package boundaries with tests or lint rules.
3. Normalize contract ownership for core, shared, agent, and local inference.
4. Migrate callers away from compatibility paths.
5. Add removal criteria for defensive fallbacks.
6. Only then remove or narrow shims in a later PR.

## Phase 0: baseline and guardrails

### TODO 0.1: record dirty-worktree assumptions

Paths:

- `packages/agent/package.json`
- `packages/agent/src/external-modules.d.ts`
- `packages/core/src/**`
- `packages/shared/src/**`
- `plugins/plugin-local-inference/**`

Risk: high. Several of these files already have concurrent edits. Do not overwrite or revert them.

Implementation:

- Before any cleanup PR, capture `git status --short` and identify unrelated work.
- For files with concurrent edits, inspect diffs before patching and keep changes additive.

Commands:

```sh
git status --short -- packages/core packages/agent packages/shared plugins/plugin-local-inference
git diff -- packages/agent/package.json packages/agent/src/external-modules.d.ts
git diff -- packages/shared/src/local-inference packages/shared/src/local-inference-gpu
git diff -- plugins/plugin-local-inference
```

Validation:

- Cleanup branch only contains intended files.
- No source file is reverted as a side effect.

### TODO 0.2: add export snapshots before narrowing barrels

Paths:

- `packages/core/src/index.ts`
- `packages/core/src/index.node.ts`
- `packages/core/src/index.browser.ts`
- `packages/agent/src/index.ts`
- `packages/shared/src/index.ts`
- `plugins/plugin-local-inference/src/index.ts`
- `plugins/plugin-local-inference/src/services/index.ts`
- `packages/shared/src/local-inference/index.ts`

Risk: high. These are broad compatibility surfaces. Removing a name that looks unused locally may break app-core, UI, plugin, or published-package consumers.

Implementation:

- Add a test helper that imports each public entry after build and snapshots `Object.keys(module).sort()`.
- Snapshot type-only surfaces separately where runtime import cannot see types.
- Keep snapshots as approval checkpoints, not as a permanent block to intentional API changes.

Commands:

```sh
bun run --filter @elizaos/core build
bun run --filter @elizaos/agent build
bun run --filter @elizaos/shared build
bun run --filter @elizaos/plugin-local-inference build
node -e 'import("./packages/core/dist/node/index.node.js").then(m=>console.log(Object.keys(m).sort().join("\n")))'
node -e 'import("./packages/agent/dist/index.js").then(m=>console.log(Object.keys(m).sort().join("\n")))'
node -e 'import("./packages/shared/dist/index.js").then(m=>console.log(Object.keys(m).sort().join("\n")))'
node -e 'import("./plugins/plugin-local-inference/dist/index.js").then(m=>console.log(Object.keys(m).sort().join("\n")))'
```

Validation:

- Snapshots exist before any export pruning.
- Built package imports work from `dist`, not only source aliases.

## Phase 1: package boundaries

### TODO 1.1: define `shared` boundary or rename its role

Paths:

- `packages/shared/package.json`
- `packages/shared/src/connectors.ts`
- `packages/shared/src/recent-messages-state.ts`
- `packages/shared/src/utils/character-message-examples.ts`
- `packages/shared/src/utils/sql-compat.ts`
- `packages/shared/src/awareness/registry.ts`
- `packages/shared/src/contracts/apps.ts`
- `packages/shared/src/contracts/awareness.ts`
- `packages/shared/src/config/types.*.ts`
- `packages/shared/src/elizacloud/server-cloud-tts.ts`
- `packages/shared/src/local-inference/paths.ts`

Risk: high. `@elizaos/shared` currently imports runtime types/functions from `@elizaos/core`, while core intentionally inlines some shared helpers to avoid depending back on shared.

Implementation:

- Choose one boundary policy:
  - Option A: `shared` is allowed to depend on `core`; document it as runtime-adjacent, not low-level.
  - Option B: `shared` becomes contracts-only; move core-coupled helpers to `core`, `agent`, or a new lower-level contracts package.
- If choosing Option A, change internal dependency version drift first: `packages/shared/package.json` should not pin `@elizaos/core` to `2.0.0-alpha.537` during workspace development.
- If choosing Option B, start with type-only imports and simple helpers, not large behavior modules.

Commands:

```sh
rg -n 'from "@elizaos/core"|import\\("@elizaos/core"\\)' packages/shared/src
rg -n 'Inlined from @elizaos/shared|Mirrors `@elizaos/shared' packages/core/src
bun run --filter @elizaos/shared typecheck
bun run --filter @elizaos/core typecheck
```

Validation:

- No `core -> shared` import cycle is introduced.
- `@elizaos/shared` typecheck passes from a clean checkout.
- App/UI packages that import shared contracts still build.

### TODO 1.2: stop publishing stale internal version pins

Paths:

- `packages/shared/package.json`
- `packages/skills/package.json`
- `packages/agent/package.json`
- `packages/core/package.json`

Risk: medium-high for published packages. `packages/shared` and `packages/skills` have used older `@elizaos/core` pins while source expects current workspace APIs.

Implementation:

- Standardize local monorepo dependencies on `workspace:*`.
- If release tooling rewrites workspace ranges, document that in package README or release docs.
- Add a CI check for `@elizaos/*` dependencies in target runtime/domain packages that are neither `workspace:*` nor the package version being released.

Commands:

```sh
jq '.dependencies // {}' packages/shared/package.json
jq '.dependencies // {}' packages/skills/package.json
rg -n '"@elizaos/(core|shared|agent|plugin-local-inference|skills|vault|prompts)"\\s*:\\s*"(?!workspace:\\*)' packages/*/package.json plugins/*/package.json
bun install --frozen-lockfile
```

Validation:

- Workspace build still resolves local packages.
- Packed tarballs resolve correct released versions in a temp install.

## Phase 2: server surface consolidation

### TODO 2.1: split `packages/agent/src/api/server.ts` into stable mount points

Paths:

- `packages/agent/src/api/server.ts`
- `packages/agent/src/api/chat-routes.ts`
- `packages/agent/src/api/server-route-dispatch.ts`
- `packages/agent/src/api/hono-mount.ts`
- `packages/agent/src/api/dispatch-route.ts`
- `packages/agent/src/api/static-file-server.ts`

Risk: high. `server.ts` is a compatibility hub and exports many helpers through `packages/agent/src/index.ts`.

Implementation:

- Do not create a new `packages/server` package until existing imports are mapped.
- First create an explicit server module map:
  - HTTP server bootstrap: `server.ts`
  - route dispatch: `server-route-dispatch.ts`, `dispatch-route.ts`, `hono-mount.ts`
  - OpenAI/Anthropic compat chat: `chat-routes.ts`, `compat-utils.ts`
  - static app assets: `static-file-server.ts`
  - plugin-owned routes: plugin packages
- Add tests that import each route module directly and through `@elizaos/agent`.
- Only after route imports are stable, consider extracting a package.

Commands:

```sh
wc -l packages/agent/src/api/server.ts packages/agent/src/api/chat-routes.ts
rg -n 'from "./api/server|from "@elizaos/agent"|startApiServer|handleLocalInferenceRoutes|handleTriggerRoutes' packages plugins apps
bun run --filter @elizaos/agent typecheck
bun run --filter @elizaos/agent test -- --runInBand
```

Validation:

- `startApiServer` import path remains stable.
- Existing plugin route mounting still works.
- `/api/health`, `/api/local-inference/*`, `/v1/models`, `/v1/chat/completions`, and `/v1/messages` pass smoke tests.

### TODO 2.2: remove duplicated HTTP helpers only after call sites converge

Paths:

- `packages/core/src/api/http-helpers.ts`
- `packages/core/src/api/route-helpers.ts`
- `packages/shared/src/api/http-helpers.ts`
- `packages/shared/src/api/route-helpers.ts`
- `packages/agent/src/api/server.ts`
- `plugins/plugin-local-inference/src/routes/compat-helpers.ts`

Risk: high. There are overlapping `sendJson`, `sendJsonError`, `readJsonBody`, `ReadJsonBodyOptions`, `RouteRequestContext`, and auth helper concepts across packages.

Implementation:

- Inventory all helper signatures first; do not blindly replace because parameter order differs in some helpers.
- Choose one canonical package for generic HTTP helpers. Candidate: `@elizaos/core` for runtime routes, or `@elizaos/shared` for app/plugin route contracts. Avoid both.
- Keep auth-specific helpers separate from generic JSON/body helpers.
- Migrate plugin-local-inference `compat-helpers.ts` to import generic JSON/body helpers while keeping local auth policy local.

Commands:

```sh
rg -n 'sendJson\\(|sendJsonError\\(|readJsonBody\\(|ReadJsonBodyOptions|RouteRequestContext|RouteHelpers' packages/core/src packages/shared/src packages/agent/src plugins/plugin-local-inference/src
bun run --filter @elizaos/core test -- src/api
bun run --filter @elizaos/shared test
bun run --filter @elizaos/agent test -- src/api
bun run --filter @elizaos/plugin-local-inference test -- src/routes
```

Validation:

- No route changes response status/body shape.
- Large-body rejection, invalid JSON, and auth failures still return expected responses.
- `plugins/plugin-local-inference/src/routes/local-inference-compat-routes.test.ts` passes.

## Phase 3: agent shims and re-exports

### TODO 3.1: classify every `@elizaos/agent` root re-export

Paths:

- `packages/agent/src/index.ts`
- `packages/agent/package.json`
- `packages/agent/src/api/server.ts`
- `packages/agent/src/api/server-helpers.ts`
- `packages/agent/src/api/server-auth.ts`
- `packages/agent/src/api/server-types.ts`
- `packages/agent/src/config/types*.ts`

Risk: high. `packages/agent/src/index.ts` includes explicit compatibility re-exports for an older `@elizaos/app-core` alpha bundle and many broad source exports.

Implementation:

- Add a table near the root barrel, or in docs, grouping exports as:
  - stable public
  - app-core alpha compatibility
  - internal but currently exported
  - test-only
- For each compatibility export, name the dependent package/version and removal condition.
- Add subpath exports for stable modules before removing root re-exports.

Commands:

```sh
sed -n '1,220p' packages/agent/src/index.ts
rg -n 'from "@elizaos/agent"|@elizaos/agent/' packages plugins apps test
bun run --filter @elizaos/agent build
cd packages/agent/dist && npm pack --dry-run
```

Validation:

- Packed `@elizaos/agent` includes only intended files.
- App-core packaged runtime can still import required compat names.
- Export snapshot changes are reviewed intentionally.

### TODO 3.2: migrate config type re-export shims to explicit subpaths

Paths:

- `packages/agent/src/config/types.ts`
- `packages/agent/src/config/types.eliza.ts`
- `packages/agent/src/config/types.agents.ts`
- `packages/agent/src/config/types.agent-defaults.ts`
- `packages/agent/src/config/types.messages.ts`
- `packages/agent/src/config/types.hooks.ts`
- `packages/shared/src/config/types*.ts`

Risk: medium. The files are one-line `export * from "@elizaos/shared"` shims, which preserve old import paths but hide ownership.

Implementation:

- Replace wildcard shims with explicit type exports from the matching shared config files.
- If consumers still import `@elizaos/agent/config/types.*`, keep the file but make it a narrow compatibility alias.
- Add comments with removal criteria.

Commands:

```sh
rg -n '@elizaos/agent/config/types|config/types\\.eliza|config/types\\.agents|config/types\\.messages|config/types\\.hooks' packages plugins apps
bun run --filter @elizaos/agent typecheck
bun run --filter @elizaos/shared typecheck
```

Validation:

- No duplicate export collisions in `packages/agent/src/index.ts`.
- Consumers can import the explicit shared config paths.

### TODO 3.3: replace ambient plugin declarations with package-owned types

Paths:

- `packages/agent/src/external-modules.d.ts`
- `plugins/plugin-capacitor-bridge/src/**`
- `plugins/plugin-elizacloud/src/**`
- `plugins/plugin-signal/src/**`
- `plugins/plugin-whatsapp/src/**`
- `plugins/plugin-computeruse/src/**`
- `plugins/plugin-mcp/src/**`
- `plugins/plugin-discord/src/**`

Risk: medium-high. Ambient declarations let agent compile when plugin packages lack complete types, but they drift from actual exports.

Implementation:

- Split `external-modules.d.ts` into tracked TODO buckets by plugin.
- For each declared plugin module, move the declaration to the plugin package or add an exported type from the plugin's public entry.
- Remove ambient declarations only after source import typecheck passes.

Commands:

```sh
rg -n '^declare module "@elizaos/' packages/agent/src/external-modules.d.ts
bun run --filter @elizaos/agent typecheck
bun run --filter @elizaos/plugin-capacitor-bridge typecheck
bun run --filter @elizaos/plugin-elizacloud typecheck
```

Validation:

- Agent typecheck does not depend on stale ambient declarations.
- Plugin package exports match actual runtime exports.

## Phase 4: local-inference contract ownership

### TODO 4.1: make `@elizaos/shared/local-inference` the only contract source

Paths:

- `packages/shared/src/local-inference/index.ts`
- `packages/shared/src/local-inference/types.ts`
- `packages/shared/src/local-inference/catalog.ts`
- `packages/shared/src/local-inference/gpu-profiles.ts`
- `packages/shared/src/local-inference-gpu/index.ts`
- `plugins/plugin-local-inference/src/services/types.ts`
- `plugins/plugin-local-inference/src/services/catalog.ts`
- `plugins/plugin-local-inference/src/services/index.ts`

Risk: high. Current plugin service files are compatibility shims over shared, while plugin service index re-exports a mix of shared contracts and plugin behavior.

Implementation:

- Keep shared as the source for DTOs and catalog constants:
  - `CatalogModel`
  - `InstalledModel`
  - `ModelAssignments`
  - `LocalInferenceReadiness`
  - `LocalRuntime*`
  - GPU profile constants
- Keep plugin-local-inference as owner of behavior:
  - loaders
  - active model management
  - routes
  - engine
  - device bridge
  - DFlash and voice services
- Add a rule: plugin `services/types.ts` and `services/catalog.ts` remain compatibility-only until callers migrate to `@elizaos/shared/local-inference`.
- Add deprecation comments with removal target.

Commands:

```sh
rg -n 'services/(types|catalog)|@elizaos/shared/local-inference|@elizaos/shared' plugins/plugin-local-inference/src packages/agent/src packages/app-core/src packages/ui/src
bun run --filter @elizaos/shared typecheck
bun run --filter @elizaos/plugin-local-inference typecheck
bun run --filter @elizaos/plugin-local-inference test
```

Validation:

- Plugin tests pass after moving type imports.
- UI/app-core can import contracts from shared without importing plugin behavior.
- Plugin service entry can still import from `./types` during transition.

### TODO 4.2: resolve GPU profile source-of-truth split

Paths:

- `packages/shared/src/local-inference/gpu-profiles.ts`
- `packages/shared/src/local-inference-gpu/profiles/*.yaml`
- `packages/shared/src/local-inference-gpu/gpu-profile-loader.ts`
- `packages/shared/src/local-inference-gpu/gpu-tier-profiles.ts`
- `packages/shared/src/local-inference-gpu/gpu-overrides.ts`
- `plugins/plugin-local-inference/native/verify/kernel-contract.json`
- `plugins/plugin-local-inference/native/verify/check_kernel_contract.mjs`

Risk: high. GPU JSON profiles appear to have concurrent delete changes, YAML profiles are being edited, and TypeScript constants plus YAML metadata can drift.

Implementation:

- Decide whether YAML profiles or TS constants are canonical for each field.
- Generate one from the other or add drift tests.
- Do not remove JSON/YAML files in this cleanup pass; first make loader/tests prove which files are used.
- Add a manifest of profile fields:
  - card identity
  - VRAM/RAM
  - recommended tier
  - DFlash tuning
  - verify recipe
  - kernel requirements

Commands:

```sh
rg -n 'GPU_PROFILES|profiles/.*\\.json|profiles/.*\\.yaml|gpu-tier-profiles|gpu-overrides' packages/shared/src plugins/plugin-local-inference
bun run --filter @elizaos/shared test -- src/local-inference-gpu
bun run --filter @elizaos/plugin-local-inference test -- src/services/gpu
node plugins/plugin-local-inference/native/verify/check_kernel_contract.mjs
```

Validation:

- YAML and TS profile IDs match.
- Recommended bundle IDs exist in `MODEL_CATALOG`.
- Kernel contract checker passes.

### TODO 4.3: formalize local-inference HTTP API contracts

Paths:

- `plugins/plugin-local-inference/src/routes/local-inference-compat-routes.ts`
- `plugins/plugin-local-inference/src/routes/compat-helpers.ts`
- `packages/agent/src/api/server.ts`
- `packages/agent/src/api/chat-routes.ts`
- `packages/agent/src/api/health-routes.ts`
- `packages/shared/src/local-inference/types.ts`

Risk: high. Agent routes directly call plugin route handlers and chat command helpers. API request/response DTOs are not all explicit shared contracts.

Implementation:

- Add shared request/response types for:
  - model hub snapshot
  - download start/cancel
  - routing preferences
  - assignments
  - active model switch
  - device bridge status
  - chat command result metadata
- Route code should parse untrusted JSON locally, then return shared DTOs.
- Keep `compat` in route file names until clients migrate; do not rename URLs yet.

Commands:

```sh
rg -n '/api/local-inference|LocalInferenceChat|handleLocalInferenceChatCommand|getLocalInferenceActiveSnapshot|getLocalInferenceChatStatus' packages/agent/src plugins/plugin-local-inference/src packages/shared/src
bun run --filter @elizaos/plugin-local-inference test -- src/routes/local-inference-compat-routes.test.ts
bun run --filter @elizaos/agent test -- src/api
```

Validation:

- Route tests assert exact response shapes for success and error cases.
- `/api/local-inference/device-bridge/status` and websocket path remain working.
- `/v1/chat/completions` local-inference command handling remains working.

### TODO 4.4: separate local-inference recommendation policy from install/runtime state

Paths:

- `packages/shared/src/local-inference/catalog.ts`
- `plugins/plugin-local-inference/src/services/recommendation.ts`
- `plugins/plugin-local-inference/src/services/service.ts`
- `plugins/plugin-local-inference/src/services/active-model.ts`
- `plugins/plugin-local-inference/src/services/ensure-local-artifacts.ts`

Risk: medium-high. Catalog publish status, default eligibility, verification state, hardware fit, and installed state all influence first-run behavior.

Implementation:

- Keep static catalog metadata in shared.
- Keep runtime installed/verified state in plugin service.
- Make first-run recommendation accept a single input object:
  - hardware probe
  - installed models
  - verification state
  - catalog publish status
  - optional env override
- Avoid reading process env inside pure catalog helpers except through injected config, or isolate env reads.

Commands:

```sh
rg -n 'recommendForFirstRun|DEFAULT_ELIGIBLE_MODEL_IDS|ELIZA_1_TIER_PUBLISH_STATUS|bundleVerifiedAt|publishStatus' packages/shared/src plugins/plugin-local-inference/src
bun run --filter @elizaos/plugin-local-inference test -- src/services/recommendation.test.ts
bun run --filter @elizaos/plugin-local-inference test -- src/services/ensure-local-artifacts.integration.test.ts
```

Validation:

- First-run recommender never selects unverified pending bundles.
- Env override behavior is covered by tests.
- Installed legacy entries without `sha256` still self-heal only where intended.

## Phase 5: duplicate/shared types

### TODO 5.1: consolidate `asRecord` and type guards

Paths:

- `packages/core/src/utils/type-guards.ts`
- `packages/shared/src/type-guards.ts`
- `packages/agent/src/api/connector-account-routes.ts`
- `packages/agent/src/runtime/trajectory-internals.ts`
- `packages/core/src/contracts/service-routing.ts`
- `packages/shared/src/contracts/service-routing.ts`

Risk: medium. `asRecord` exists in core and shared, and some agent code has local versions. Moving it can create a core/shared cycle.

Implementation:

- If `shared` remains core-dependent, canonicalize to one exported helper and migrate local duplicates.
- If `shared` becomes contracts-only, move the helper to a lower-level no-dependency package or keep duplicate implementations with drift tests.
- Start by replacing local copies inside `packages/agent` with whichever package already owns the caller's import set.

Commands:

```sh
rg -n 'function asRecord|export function asRecord|import \\{ asRecord' packages/core/src packages/shared/src packages/agent/src plugins/plugin-local-inference/src
bun run --filter @elizaos/core test -- src/contracts
bun run --filter @elizaos/shared test -- src/contracts
bun run --filter @elizaos/agent test -- src/api/connector-account-routes.test.ts
```

Validation:

- No new package cycle.
- Route parsing tests still pass.

### TODO 5.2: consolidate config and route contract types

Paths:

- `packages/core/src/api/route-helpers.ts`
- `packages/shared/src/api/route-helpers.ts`
- `packages/agent/src/api/*-routes.ts`
- `packages/shared/src/contracts/*-routes.ts`
- `packages/agent/src/config/types*.ts`
- `packages/shared/src/config/types*.ts`

Risk: medium-high. Agent routes import `RouteRequestContext` and `ReadJsonBodyOptions` from both core and shared. Config type shims re-export everything from shared.

Implementation:

- Choose canonical owner for route helper types.
- Update agent route modules to import all route context helpers from that owner.
- Use shared contracts for request/response schemas; use core only for runtime execution types.
- Replace wildcard config shims with explicit exports.

Commands:

```sh
rg -n 'RouteRequestContext|RouteRequestMeta|RouteHelpers|ReadJsonBodyOptions' packages/core/src packages/shared/src packages/agent/src
rg -n 'export \\* from "@elizaos/shared"' packages/agent/src/config
bun run --filter @elizaos/agent typecheck
bun run --filter @elizaos/shared test -- src/contracts
```

Validation:

- Route type imports have one canonical owner.
- No TS duplicate export errors in `@elizaos/agent`.

### TODO 5.3: align local-inference kernel enums

Paths:

- `packages/shared/src/local-inference/types.ts`
- `plugins/plugin-local-inference/src/services/manifest/schema.ts`
- `plugins/plugin-local-inference/src/services/active-model.ts`
- `plugins/plugin-local-inference/native/verify/kernel-contract.json`

Risk: high. Shared `LocalRuntimeKernel` comments note it differs from bundle-manifest kernel names and requires translation.

Implementation:

- Add explicit conversion tests for manifest kernel names to runtime kernel names.
- Put conversion tables in one module.
- Make native kernel contract checker import or generate from the same enum list if feasible.

Commands:

```sh
rg -n 'LocalRuntimeKernel|Eliza1Kernel|ELIZA1_TO_RUNTIME_KERNEL|RUNTIME_TO_ELIZA1_KERNEL|kernel-contract' packages/shared/src plugins/plugin-local-inference/src plugins/plugin-local-inference/native
bun run --filter @elizaos/plugin-local-inference test -- src/services/manifest
node plugins/plugin-local-inference/native/verify/check_kernel_contract.mjs
```

Validation:

- Every manifest kernel maps to one runtime kernel or has an intentional unsupported status.
- Required model kernels are present in native verify contract.

## Phase 6: shims and compatibility re-exports

### TODO 6.1: make a shim registry

Paths:

- `packages/core/src/prompts.ts`
- `packages/core/src/runtime/cost-table.ts`
- `packages/core/src/features/advanced-capabilities/form/index.ts`
- `packages/core/src/features/basic-capabilities/index.ts`
- `packages/agent/src/index.ts`
- `packages/agent/src/config/types*.ts`
- `packages/agent/src/api/documents-service-loader.ts`
- `packages/agent/src/runtime/pglite-error-compat.ts`
- `plugins/plugin-local-inference/src/services/catalog.ts`
- `plugins/plugin-local-inference/src/services/types.ts`

Risk: medium-high. Compatibility files are scattered and may stay forever without ownership.

Implementation:

- Create a markdown registry, or add comments near each shim, with:
  - shim path
  - canonical replacement path
  - current consumers
  - removal condition
  - validation command
- Do not remove shims in the registry PR.

Commands:

```sh
rg -n 'compat|compatibility|backward|backwards|legacy|shim|preserved|re-export|reexport' packages/core/src packages/agent/src plugins/plugin-local-inference/src packages/shared/src
rg -n '@elizaos/agent/config/types|runtime/cost-table|features/advanced-capabilities/form|services/catalog|services/types' packages plugins apps test
```

Validation:

- Every shim has an owner and removal condition.
- No shim is removed without a consumer scan.

### TODO 6.2: narrow plugin-local-inference service barrel

Paths:

- `plugins/plugin-local-inference/src/services/index.ts`
- `plugins/plugin-local-inference/package.json`

Risk: medium. `services/index.ts` exports deep internals such as engine, device bridge, metrics, backend dispatcher, manifest, voice, and recommendation helpers.

Implementation:

- Split service exports into:
  - public stable service API
  - route-only API
  - test/internal API
- Add package subpaths if external consumers need deep imports.
- Keep existing exports until import scans prove they can move.

Commands:

```sh
rg -n '@elizaos/plugin-local-inference/services|plugin-local-inference/src/services' packages plugins apps test
bun run --filter @elizaos/plugin-local-inference build
cd plugins/plugin-local-inference && npm pack --dry-run
```

Validation:

- Agent server imports from root/routes where possible, not service internals.
- Public root import remains small.

### TODO 6.3: move app/plugin route handlers out of agent server imports where possible

Paths:

- `packages/agent/src/api/server.ts`
- `packages/agent/src/api/index.ts`
- `plugins/plugin-local-inference/src/routes/index.ts`
- `plugins/plugin-workflow/src/**`
- `plugins/plugin-streaming/src/**`
- `plugins/plugin-computeruse/src/**`

Risk: medium-high. Agent server has top-level imports from multiple plugin packages, so server startup can be coupled to optional plugin availability.

Implementation:

- Prefer plugin route registration through plugin `routes` metadata where available.
- For required boot routes, keep top-level imports but document that they are hard dependencies.
- For optional routes, use dynamic import with explicit error handling and tests.

Commands:

```sh
rg -n 'from "@elizaos/plugin-' packages/agent/src/api/server.ts packages/agent/src/api/index.ts
rg -n 'routes\\s*:' plugins/*/src packages/agent/src/runtime
bun run --filter @elizaos/agent test -- src/api/server-helpers-swarm.test.ts src/api/build-variant-routes.test.ts
```

Validation:

- Agent can start when optional plugin is absent, if absence is supported.
- Required plugin absence fails fast with a clear message.

## Phase 7: defensive fallback cleanup

### TODO 7.1: classify chat fallback execution paths

Paths:

- `packages/agent/src/api/chat-routes.ts`
- `packages/agent/src/api/binance-skill-helpers.ts`
- `packages/agent/src/api/parse-action-block.ts`
- `packages/agent/src/actions/grounded-action-reply.ts`
- `packages/core/src/runtime/message-handler.ts`
- `packages/core/src/runtime/planner-loop.ts`

Risk: high. Fallback action parsing can execute actions when core did not dispatch actions itself. Cleanup must not break compatibility clients or create duplicate action execution.

Implementation:

- Add telemetry or tests distinguishing:
  - core-dispatched actions
  - callback-driven actions
  - parsed fallback action blocks
  - intentionally no-response flows
- Gate fallback execution behind explicit conditions and document each condition.
- Add a deprecation plan for parsing model text into actions if core structured output fully replaces it.

Commands:

```sh
rg -n 'fallback action|parseFallbackActionBlocks|executeFallbackParsedActions|coreHandledActions|actionCallbacksSeen|isExecutableFallbackAction' packages/agent/src packages/core/src
bun run --filter @elizaos/agent test -- src/api/parse-action-block.test.ts
bun run --filter @elizaos/agent test -- src/api
bun run --filter @elizaos/core test -- src/runtime
```

Validation:

- No duplicate execution when core dispatches actions.
- Fallback paths are covered by tests with explicit expected action count.

### TODO 7.2: classify local-inference fallbacks by user-visible behavior

Paths:

- `plugins/plugin-local-inference/src/services/cloud-fallback.ts`
- `plugins/plugin-local-inference/src/services/backend-selector.ts`
- `plugins/plugin-local-inference/src/services/runtime-dispatcher.ts`
- `plugins/plugin-local-inference/src/services/recommendation.ts`
- `plugins/plugin-local-inference/src/services/cache-bridge.test.ts`
- `packages/agent/src/api/chat-routes.ts`

Risk: medium-high. Some fallbacks are user-visible routing choices; others are compatibility or resilience paths. They should not be cleaned up with one rule.

Implementation:

- Classify fallbacks as:
  - user-selected cloud/local routing
  - cloud fallback after local failure
  - backend selector fallback
  - smaller model fallback
  - legacy cache filename fallback
  - structured event fallback
- For each class, define whether it can be removed, needs UI messaging, or must stay.

Commands:

```sh
rg -n 'fallback|legacy|compat|cloud fallback|chooseSmallerFallbackModel|legacy synthesis|legacy / unencoded' plugins/plugin-local-inference/src packages/agent/src/api/chat-routes.ts
bun run --filter @elizaos/plugin-local-inference test -- src/services/recommendation.test.ts src/services/cache-bridge.test.ts
bun run --filter @elizaos/plugin-local-inference test -- src/services/dflash-structured.test.ts
```

Validation:

- Local failure messages are deterministic.
- Cloud fallback does not hide local failure state.
- Legacy cache cleanup behavior remains covered.

### TODO 7.3: classify runtime legacy env/config fallbacks

Paths:

- `packages/core/src/utils/read-env.ts`
- `packages/core/src/utils/state-dir.ts`
- `packages/core/src/contracts/onboarding.ts`
- `packages/agent/src/api/config-routes.ts`
- `packages/agent/src/runtime/local-execution-mode.ts`
- `packages/shared/src/runtime-env.ts`

Risk: medium. Env/config fallbacks affect user data directories, cloud/local routing, and packaged app startup.

Implementation:

- List every legacy env var and config alias.
- Add one warning path per alias, not repeated logs.
- Add removal window only for aliases that do not affect persisted data.
- Keep `MILADY_STATE_DIR` migration longer than non-persistent aliases.

Commands:

```sh
rg -n 'MILADY|legacy|deprecated|fallback|ELIZA_' packages/core/src packages/agent/src packages/shared/src
bun run --filter @elizaos/core test -- src/utils/state-dir.test.ts src/utils/read-env.test.ts
bun run --filter @elizaos/agent test -- src/api/config-routes
```

Validation:

- Existing users with legacy state dirs still migrate safely.
- Config read/write tests preserve canonical output shape.

### TODO 7.4: classify plugin loading fallbacks

Paths:

- `packages/agent/src/runtime/eliza.ts`
- `packages/agent/src/runtime/plugin-resolver.ts`
- `packages/agent/src/runtime/plugin-collector.ts`
- `packages/agent/src/runtime/pglite-error-compat.ts`
- `packages/agent/src/services/plugin-installer.ts`

Risk: high. Plugin resolution supports mobile bundles, workspace overrides, ejected plugins, installed plugins, and node_modules packages. Cleanup can break packaged apps.

Implementation:

- Draw a resolver precedence table:
  - static registry
  - ejected plugin
  - official plugin from node_modules
  - workspace override
  - installed path
  - mobile skip
- Add tests for each branch before changing logic.
- Replace local `pglite-error-compat.ts` only after `@elizaos/plugin-sql` exports the canonical errors in the consumed version.

Commands:

```sh
rg -n 'STATIC_ELIZA_PLUGINS|workspace override|ejected|installRecord|plugin-sql|pglite-error-compat|loadOptionalPlugin' packages/agent/src/runtime packages/agent/src/services
bun run --filter @elizaos/agent test -- src/runtime/plugin-collector-aosp.test.ts src/runtime/plugin-collector-mode-policy.test.ts src/runtime/load-plugin-from-vfs.test.ts
bun run --filter @elizaos/agent typecheck
```

Validation:

- Mobile bundle path still skips unavailable optional plugins.
- Workspace override reload remains working.
- Official plugin loading does not regress in packaged dist.

## Phase 8: validation matrix

Run these after each cleanup phase that changes source.

### Core

Commands:

```sh
bun run --filter @elizaos/core typecheck
bun run --filter @elizaos/core test
bun run --filter @elizaos/core build
```

Required smoke:

- Root/node/browser imports.
- Runtime message handler tests.
- State-dir/read-env tests.
- Action dispatch/planner tests.

### Agent and server surface

Commands:

```sh
bun run --filter @elizaos/agent typecheck
bun run --filter @elizaos/agent test
bun run --filter @elizaos/agent build
cd packages/agent/dist && npm pack --dry-run
```

Required smoke:

- `node -e 'import("./packages/agent/dist/index.js")'`
- `startApiServer` import through root.
- `/api/health`
- `/api/local-inference/models`
- `/v1/models`
- `/v1/chat/completions`
- websocket upgrade route does not throw.

### Shared

Commands:

```sh
bun run --filter @elizaos/shared typecheck
bun run --filter @elizaos/shared test
bun run --filter @elizaos/shared build
cd packages/shared/dist && npm pack --dry-run
```

Required smoke:

- `@elizaos/shared`
- `@elizaos/shared/local-inference`
- `@elizaos/shared/local-inference-gpu` if exported/consumed by build output.
- Contract schema tests.

### Plugin local inference

Commands:

```sh
bun run --filter @elizaos/plugin-local-inference typecheck
bun run --filter @elizaos/plugin-local-inference test
bun run --filter @elizaos/plugin-local-inference build
cd plugins/plugin-local-inference && npm pack --dry-run
```

Required smoke:

- Root import.
- Route subpath import if retained.
- Services subpath import if retained.
- Local-inference compat route tests.
- Recommendation tests.
- GPU profile tests.
- Kernel contract check.

### Cross-package import checks

Commands:

```sh
rg -n 'from "@elizaos/shared"|from "@elizaos/core"|from "@elizaos/agent"|from "@elizaos/plugin-local-inference"' packages/core/src packages/agent/src packages/shared/src plugins/plugin-local-inference/src
rg -n 'plugins/.*/test|\\.\\./\\.\\./\\.\\./plugins/.*/test' packages/core packages/agent packages/shared plugins/plugin-local-inference
rg -n 'export \\* from "@elizaos/shared"|export \\* from "@elizaos/core"' packages/agent/src packages/shared/src packages/core/src
```

Pass criteria:

- No source package imports plugin test helpers.
- No new core/shared cycle.
- Shims remain documented if still present.
- Export snapshots have reviewed diffs.

## Later deletion candidates, not for first implementation PR

Do not delete these until imports are migrated, snapshots are updated, and validation passes.

- `packages/agent/src/config/types*.ts` wildcard shared re-export shims.
- `packages/agent/src/runtime/pglite-error-compat.ts`, after plugin-sql exports compatible errors.
- `plugins/plugin-local-inference/src/services/catalog.ts`, after callers use `@elizaos/shared/local-inference`.
- `plugins/plugin-local-inference/src/services/types.ts`, after callers use `@elizaos/shared/local-inference`.
- Local duplicate HTTP helper implementations, after route helpers are canonicalized.
- Fallback action parsing paths in `packages/agent/src/api/chat-routes.ts`, after core structured action dispatch has complete coverage and external compat clients are migrated.
- Ambient declarations in `packages/agent/src/external-modules.d.ts`, after plugin packages own their public types.

## Suggested PR breakdown

1. Export snapshots and import-boundary tests only.
2. Shared/core boundary documentation and dependency range cleanup.
3. Route/helper type ownership cleanup with no behavior changes.
4. Local-inference contract import migration to `@elizaos/shared/local-inference`.
5. Shim registry and deprecation comments.
6. Defensive fallback classification tests.
7. Actual shim removals, one domain at a time.
