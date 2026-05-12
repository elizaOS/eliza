# Phase 4 - Shims, Legacy, Re-exports Removal Audit

Date: 2026-05-11

Scope: identify duplication, deprecation, legacy, fallback, stub, shim,
compatibility files, re-exports, barrel files, and obsolete names that can be
removed or collapsed with no behavior change. This pass did not delete or edit
source code.

## Method

Read-only checks used:

```bash
rg --files \
  | rg -i '(shim|stub|compat|legacy|deprecated|fallback|reexport|re-export|barrel|unified|consolidated)'

rg -n -i '(shim|stub|compat|legacy|deprecated|fallback|re-export|reexport|backward|consolidated|unified)' \
  packages plugins cloud test \
  -g '!**/node_modules/**' \
  -g '!**/dist/**' \
  -g '!**/build/**' \
  -g '!packages/agent/dist-mobile*/**'

node scripts/audit-package-barrels.mjs
```

Targeted reference checks are recorded in the relevant sections below. The
audit treats generated bundles, vendored benchmark corpora, and prior cleanup
reports as evidence only when they point to live source paths.

## Executive Summary

The repo has a small set of high-confidence, no-internal-reference deletion
candidates. Most of the larger cleanup is not a blind delete: it is public API
or package-boundary cleanup where internal imports must first move to canonical
modules, then wildcard/subpath exports can be removed.

Important counts from `node scripts/audit-package-barrels.mjs`:

| Metric | Count |
| --- | ---: |
| Workspace packages scanned | 215 |
| Source files scanned | 10,434 |
| Workspace package subpath references | 22 |
| Published package subpath exports | 267 |
| Literal re-export markers | 692 |

Top remaining workspace subpath imports:

| Count | Specifier |
| ---: | --- |
| 6 | `@elizaos/ui/api/client-types-cloud` |
| 3 | `@elizaos/ui/onboarding-config` |
| 2 | `@elizaos/ui/config/app-config` |
| 2 | `@elizaos/ui/styles` |
| 1 | `@elizaos/agent/config/plugin-auto-enable` |
| 1 | `@elizaos/agent/services/permissions/probers/index` |
| 1 | `@elizaos/agent/services/permissions/register-probers` |
| 1 | `@elizaos/app-core/services/local-inference/catalog` |
| 1 | `@elizaos/app-core/services/local-inference/downloader` |
| 1 | `@elizaos/app-lifeops/seed-routine-migrator` |
| 1 | `@elizaos/core/testing` |
| 1 | `@elizaos/shared/dev-settings-figlet-heading` |
| 1 | `@elizaos/ui/navigation` |

## High-confidence Delete Candidates

These candidates have no live internal reference found in source imports. They
still need the validation commands listed before deletion lands.

| Candidate | Symbols | Evidence | Confidence | Removal steps | Validation |
| --- | --- | --- | --- | --- | --- |
| `plugins/app-lifeops/src/lifeops/entities/resolver-shim.ts` | `ResolvedContactShim`, `ContactResolverShim`, `createContactResolverShim` | `rg -n 'resolver-shim\|ContactResolverShim\|createContactResolverShim\|ResolvedContactShim' plugins/app-lifeops packages docs/audits/repo-cleanup-2026-05-11 -g '!docs/audits/repo-cleanup-2026-05-11/phase-4-shims-legacy-reexports-removal.md'` found the file itself plus historical audit docs. No source import or export path found. The implementation plan text says this shim was temporary and deleted by Wave 2. | High for internal behavior. Medium for support-window risk because it is an intentional compatibility artifact. | Delete the file. Do not add another resolver layer. Keep `EntityStore` and `RelationshipStore` as the only graph path. | Fresh `rg` check above; `bun run lint:default-packs`; app-lifeops tests; root `bun run typecheck`; root `bun run build`. |
| `packages/app-core/src/platform/agent-browser-stub.ts` | `gatePluginSessionForHostedApp`, `hasActiveAppRunForCanonicalName`, `isHostedAppActiveForAgentActions` | `rg -n 'agent-browser-stub\|platform/agent-browser-stub' packages/app-core packages/app packages/ui packages/agent plugins -g '!**/node_modules/**' -g '!**/dist/**' -g '!**/build/**' -g '!packages/agent/dist-mobile*/**'` returned no references. Browser aliasing appears to use `elizaos-agent-browser-stub.ts`, not this older file. | High for internal behavior. | Delete only this unused `agent-browser-stub.ts`. Do not delete `elizaos-agent-browser-stub.ts` or `elizaos-plugin-elizacloud-browser-stub.ts` in the same change. | `rg` check above; `bun run --cwd packages/app-core typecheck` if available; root `bun run build`; browser/electrobun app build. |
| `plugins/plugin-coding-tools/src/lib/execution-mode.ts` | `resolveRuntimeExecutionMode`, `resolveLocalExecutionMode`, `shouldUseSandboxExecution`, deprecated `LocalExecutionMode` | The live plugin imports execution-mode helpers from `@elizaos/shared` in `src/lib/run-shell.ts` and `src/actions/bash.ts`. No import of the local `src/lib/execution-mode.ts` was found. The package has a wildcard `./*` export, so external subpath risk remains. | High for repo behavior; medium for published package API. | Delete the file after confirming no external contract depends on `@elizaos/plugin-coding-tools/lib/execution-mode`. Prefer no replacement shim. | `rg -n 'plugin-coding-tools/.*/execution-mode|src/lib/execution-mode|lib/execution-mode' packages plugins`; `bun run --cwd plugins/plugin-coding-tools typecheck`; `bun run --cwd plugins/plugin-coding-tools test`; root `bun run typecheck`. |
| `plugins/plugin-shell/utils/executionMode.ts` | `resolveRuntimeExecutionMode`, `resolveLocalExecutionMode`, `shouldUseSandboxExecution`, `isCloudExecutionMode`, deprecated `LocalExecutionMode` | The live plugin imports `isCloudExecutionMode`, `shouldUseSandboxExecution`, and `resolveRuntimeExecutionMode` from `@elizaos/shared` in `services/shellService.ts` and `utils/processQueue.ts`. No import of `utils/executionMode.ts` was found. The package has a wildcard `./*` export, so external subpath risk remains. | High for repo behavior; medium for published package API. | Delete the file after public subpath review. Do not re-export these helpers from plugin-shell; `@elizaos/shared` is canonical. | `rg -n 'plugin-shell/.*/executionMode|utils/executionMode|executionMode' packages plugins`; `bun run --cwd plugins/plugin-shell build`; root `bun run typecheck`. |

## Dead Symbols Inside Live Files

These are narrower than file deletes. They can be removed without changing
internal behavior if the package owner accepts the public API change.

| Candidate | Evidence | Confidence | Removal steps | Validation |
| --- | --- | --- | --- | --- |
| `plugins/plugin-discord/compat.ts` - remove `createCompatRuntime()` and private helper `addServerId()` only | `rg -n 'createCompatRuntime\|addServerId' plugins/plugin-discord` finds only `compat.ts`. The file comment still says to remove a `createCompatRuntime()` call in `service.ts`, but no such call exists. | High for runtime behavior. Medium for public API because wildcard exports may expose the symbol. | Delete `createCompatRuntime` and `addServerId`. Keep `ICompatRuntime`, `WorldCompat`, `RoomCompat`, and `EnsureConnectionParams` until the typed call sites migrate. | `rg -n 'createCompatRuntime\|addServerId' plugins/plugin-discord packages plugins`; `bun run --cwd plugins/plugin-discord typecheck` if available; plugin-discord tests. |
| `plugins/plugin-local-embedding/src/index.ts` - remove alias `localAiPlugin = localEmbeddingPlugin` | `rg -n 'localAiPlugin' plugins/plugin-local-embedding` finds the alias and a smoke test asserting the legacy alias. No internal production import was found. | High for repo behavior after the smoke test is updated; medium for public API. | Decide whether the old `localAiPlugin` import name is still supported. If not, delete the alias and the smoke-test expectation. | `rg -n 'localAiPlugin' packages plugins -g '!plugins/plugin-local-ai/**'`; plugin-local-embedding smoke tests; root typecheck. |

## Duplicate and Compatibility Facades with Public API Risk

These are either byte-identical duplicates or thin facades. They are not
internally needed, but deleting them can break published wildcard/subpath
imports.

| Candidate | Current role | Evidence | Confidence | Removal steps | Validation |
| --- | --- | --- | --- | --- | --- |
| `packages/ui/src/api/agent-client-type-shim.ts` | Type facade duplicating canonical API/client type definitions. | No internal import of `agent-client-type-shim` was found. Similar symbols are used from `client-types-core` and `api/client`. `packages/ui/package.json` has wildcard export `"./*"` so external `@elizaos/ui/api/agent-client-type-shim` remains possible. | High for repo behavior; medium for package API. | Remove the file after export-map review. If any app still needs the types, import from `packages/ui/src/api/client-types-core.ts` or the root UI API surface. | `rg -n 'agent-client-type-shim|AgentClientTypeShim' packages plugins`; `bun run --cwd packages/ui typecheck`; root typecheck. |
| `packages/ui/src/utils/sql-compat.ts` | Duplicate SQL utility implementation. | `cmp -s packages/shared/src/utils/sql-compat.ts packages/ui/src/utils/sql-compat.ts` returned identical content. Source references are `packages/shared/src/index.ts` and `packages/ui/src/utils/index.ts`; no internal UI consumer imports the UI copy directly. | High for repo behavior; medium for package API. | Delete the UI copy and remove or redirect the `packages/ui/src/utils/index.ts` export. Canonical source is `packages/shared/src/utils/sql-compat.ts`. | `rg -n 'ui/src/utils/sql-compat|@elizaos/ui/.*/sql-compat|sql-compat' packages plugins`; `bun run --cwd packages/ui typecheck`; root build. |
| `packages/app-core/src/ui-compat.ts` | App-core compatibility re-export of UI. | Public compatibility surface, not an internal behavior requirement. This is a package-boundary smell because app-core should not be the stable import path for UI. | Medium. | Migrate imports to `@elizaos/ui`, remove the app-core export path, then delete. | `rg -n 'ui-compat|@elizaos/app-core/.*/ui' packages plugins`; app-core and app build. |
| `plugins/plugin-browser/src/workspace/browser-workspace.ts` | Large public re-export facade. | Barrel audit flags this as a compatibility re-export file with comments saying external consumers are unaffected. It likely exists only to preserve older imports. | Medium. Needs package owner review. | Inventory external/internal imports. Move canonical exports to plugin root or specific modules, then delete the facade and subpath export. | `rg -n 'browser-workspace|plugin-browser/workspace' packages plugins`; plugin-browser tests/build; browser app smoke. |

## Re-export Shims Requiring Import Migration

Deleting these today would break internal imports. They are cleanup candidates
only after call sites move to canonical imports.

| Shim group | Exact paths | Internal references found | Canonical target | Removal plan |
| --- | --- | --- | --- | --- |
| UI local-inference shims | `packages/ui/src/services/local-inference/catalog.ts`, `paths.ts`, `routing-preferences.ts`, `types.ts`, `verify.ts` | Imports from `packages/ui/src/onboarding/auto-download-recommended.ts`, `auto-download-recommended.test.ts`, `api/client-local-inference.ts`, `api/ios-local-agent-kernel.ts`, and `components/local-inference/hub-utils.ts`. | `@elizaos/shared/local-inference/*` | Replace UI relative imports with shared imports. Then delete the UI service shim files and remove wildcard/subpath exposure. |
| App-core local-inference shims | `packages/app-core/src/services/local-inference/catalog.ts`, `paths.ts`, `routing-preferences.ts`, `types.ts`, `verify.ts` | App-core compat routes and runtime code import these paths. | `@elizaos/shared/local-inference/*` | Move app-core imports to shared. Keep only genuinely server-specific app-core modules. Validate local-inference route tests. |
| Agent execution-mode re-export | `packages/agent/src/runtime/local-execution-mode.ts` | Imported by `packages/agent/src/api/terminal-execution-routing.ts` and re-exported from `packages/agent/src/index.ts`. | `@elizaos/shared` runtime-mode exports | Replace the terminal route import and root agent export if public API removal is approved. Then delete the shim. |
| Root test helper re-export stubs | `test/helpers/live-provider.ts`, `test/helpers/live-child-env.ts`, `test/helpers/http.ts` | Many live/e2e tests import through root `test/helpers/*`; canonical implementations are under `packages/app-core/test/helpers/*`. | `packages/app-core/test/helpers/*` | Bulk rewrite test imports to canonical helper paths or promote a real shared test helper package. Then delete root stubs. |
| LifeOps Wave-1 type stubs | `plugins/app-lifeops/src/lifeops/wave1-types.ts` | Imported by `lifeops/first-run/service.ts`, `lifeops/first-run/defaults.ts`, and `providers/recent-task-states.ts`. | `plugins/app-lifeops/src/lifeops/scheduled-task/types.ts` | Replace imports with the actual scheduled-task contract. Validate the single `ScheduledTask` primitive remains the only task model. |
| LifeOps default-pack contract stubs | `plugins/app-lifeops/src/default-packs/contract-stubs.ts` | Imported by default packs, registry types, default-pack lint, and seed-routine migration. | Scheduled task types plus a real default-pack contract module. | Move `ScheduledTaskSeed` to canonical scheduled-task types or a public pack contract. Keep pack envelope types in `registry-types.ts`. Run `bun run lint:default-packs`. |
| Health contract stubs | `plugins/plugin-health/src/default-packs/contract-stubs.ts`, `plugins/plugin-health/src/connectors/contract-stubs.ts` | Imported by health default packs, connectors, and smoke tests. | Formal public contracts, not LifeOps internals. | Define the shared/public contract boundary first. Health must continue to contribute through registries and must not import LifeOps internals directly. |
| Discord compat types | `plugins/plugin-discord/compat.ts` | `ICompatRuntime` and `WorldCompat` are used by `service.ts`, `voice.ts`, `discord-interactions.ts`, `messages.ts`, `discord-history.ts`, and tests. | Current core runtime types, once core supports the needed `messageServerId` shape cleanly. | Remove dead runtime proxy now if approved; migrate type aliases later. |
| LifeOps legacy seed routines | `plugins/app-lifeops/src/lifeops/seed-routines.ts` | Referenced by service mixins, client comments/surfaces, seed-routine migration, and tests. | `plugins/app-lifeops/src/default-packs/habit-starters.ts` and scheduled-task seeds. | Do not delete until legacy seed migration has completed and tests prove no first-run or migration behavior is lost. |

## Behaviorful Legacy, Compat, Fallback, or Stub Code

The following paths are real compatibility or placeholder behavior, not
zero-behavior files. They are cleanup targets, but deletion requires either a
replacement implementation, a route/API removal decision, or a data-migration
signoff.

| Area | Exact paths | Current risk | Required decision before deletion |
| --- | --- | --- | --- |
| App-core compat routes | `packages/app-core/src/api/database-rows-compat-routes.ts`, `workbench-compat-routes.ts`, `automations-compat-routes.ts`, `local-inference-compat-routes.ts`, `dev-compat-routes.ts` | Public or in-app route compatibility. Some are still tested. | Route contract review and replacement route coverage. |
| Browser/runtime stubs still used by bundlers | `packages/app-core/src/platform/elizaos-agent-browser-stub.ts`, `packages/app-core/src/platform/elizaos-plugin-elizacloud-browser-stub.ts` | Required browser-safe aliases for Node-only packages. | Browser build must prove those aliases are no longer needed. |
| Plugin compat routes | `plugins/plugin-elizacloud/src/routes/cloud-compat-routes.ts`, `plugins/plugin-computeruse/src/routes/computer-use-compat-routes.ts` | Route compatibility surfaces. | API owner signoff plus route-level tests for replacements. |
| Steward/wallet compat routes | `plugins/app-steward/src/routes/wallet-trade-compat-routes.ts`, `steward-compat-routes.ts`, `wallet-browser-compat-routes.ts`, `wallet-compat-routes.ts` | Legacy wallet/steward API surface. | Wallet/steward route migration plan and client import scan. |
| Workflow legacy migrations | `plugins/plugin-workflow/src/lib/legacy-task-migration.ts`, `plugins/plugin-workflow/src/lib/legacy-text-trigger-migration.ts` | Data migration code invoked from plugin startup. | Confirm all deployed data has migrated or add a one-time migration marker before removal. |
| Cloud front-end shims | `cloud/apps/frontend/src/shims/inherits.cjs`, `empty.ts`, `process.ts` | Vite/Rolldown browser compatibility for Node/server imports. | Frontend bundle analysis showing these aliases are unused or no server module reaches the SPA bundle. |
| Cloud API worker stubs | `cloud/apps/api/src/stubs/elizaos-plugin-elevenlabs.ts`, `elizaos-core.ts`, `elizaos-plugin-sql.ts`, `ssh2.ts`, `undici.ts` | Worker-safe stubs for packages that are not Cloudflare-compatible. | Replace with worker-native implementations or remove dependent code paths. |
| Cloud workspace shims | `cloud/apps/api/types/workspace-shims.d.ts`, `cloud/packages/types/workspace-shims.d.ts`, `cloud/packages/tests/support/bun-partial-module-shims.ts` | Type/runtime bridge for cloud workspace tests and packages. | Cloud package typecheck/build must pass without them. |
| Payment adapter stubs | `cloud/packages/lib/services/payment-adapters/oxapay.ts`, `wallet-native.ts`, `x402.ts` | They return `https://stub.invalid/...` hosted URLs and are registered by default payment request code. | Implement real adapters or explicitly disable unsupported providers. Do not delete silently. |
| RTMP relay stub session | `cloud/services/rtmp-relay/src/index.ts` (`mintStubSession`) | API streaming sessions route calls it. | Implement real relay session minting or disable the route. |
| Cloud MCP smoke harness | `cloud/services/_smoke-mcp/*`, including `dist/worker.js`, `dist/worker.js.map`, nested `bun.lock` | Temporary smoke harness; `cloud/knip.json` ignores `_smoke-mcp/**`; `cloud/bun.lock` has workspace entries. | If verdict is recorded elsewhere, delete the service, generated dist files, workspace references, and lockfile entries together. |
| Plugin agent orchestrator sandbox stub | `plugins/plugin-agent-orchestrator/src/actions/sandbox-stub.ts` | Name indicates placeholder action behavior. | Inspect call sites and decide whether to implement real sandbox action or remove exposed action. |
| Music fallback utilities | `plugins/plugin-music/src/utils/streamFallback.ts`, `plugins/plugin-music/src/utils/ytdlpFallback.ts`, `plugins/plugin-music/src/route-fallback.ts` | Likely active fallback behavior. | Product decision on supported playback/download paths. |
| Wallet browser shim | `plugins/plugin-wallet/src/browser-shim/index.ts`, `build-shim.ts`, `shim.template.js` | Browser package compatibility. | Wallet browser build proof before removal. |

## Package Boundary and Barrel Findings

The package-level problem is not only unused files; wildcard exports make
internal cleanup look like public API cleanup.

Examples with wildcard `./*` exports:

| Package | Risk |
| --- | --- |
| `packages/ui/package.json` | Exposes internal compatibility files such as `api/agent-client-type-shim` and `utils/sql-compat` if they build to dist. |
| `plugins/plugin-coding-tools/package.json` | Exposes unused `lib/execution-mode` if built. |
| `plugins/plugin-shell/package.json` | Exposes unused `utils/executionMode` if built. |
| `plugins/plugin-social-alpha/package.json` | Exposes implementation internals while lint/typecheck are skipped. |

Barrel-audit first subpath references to clean:

| Import site | Subpath specifier |
| --- | --- |
| `packages/agent/src/services/permissions/register-probers.ts` | `@elizaos/agent/services/permissions/register-probers` |
| `packages/agent/src/config/plugin-auto-enable.ts` | `@elizaos/agent/config/plugin-auto-enable` |
| `packages/app-core/src/api/dev-route-catalog.test.ts` | `@elizaos/ui/navigation` |
| `plugins/app-lifeops/scripts/migrate-seed-routines.mjs` | `@elizaos/app-lifeops/seed-routine-migrator` |
| `packages/app-core/scripts/lib/orchestrator-desktop-dev-banner.mjs` | `@elizaos/shared/dev-settings-figlet-heading` |
| `packages/app-core/scripts/playwright-ui-live-stack.ts` | `@elizaos/ui/onboarding-config` |
| `packages/app/src/app-config.ts` | `@elizaos/ui/config/app-config` |
| `packages/app/src/main.tsx` | `@elizaos/ui/styles` |
| `packages/app/vite.config.ts` | `@elizaos/ui/config/app-config` |
| `packages/ui/src/styles.ts` | `@elizaos/ui/styles` |
| `packages/app-core/platforms/electrobun/src/native/permissions.ts` | `@elizaos/agent/services/permissions/probers/index` |
| `plugins/app-task-coordinator/src/*Pty*` and `CodingAgentTasksPanel.tsx` | `@elizaos/ui/api/client-types-cloud` |
| `scripts/verify-phone-download.mjs` | `@elizaos/app-core/services/local-inference/catalog`, `@elizaos/app-core/services/local-inference/downloader` |
| app-core live onboarding tests | `@elizaos/ui/onboarding-config` |

Remediation order:

1. Add or confirm canonical root exports only where the symbol truly belongs in
   the public package API.
2. Replace all workspace package subpath imports with root imports or direct
   source-relative imports inside the same package.
3. Remove wildcard `./*` exports from package manifests package by package.
4. Delete now-unreachable compatibility files.
5. Re-run `node scripts/audit-package-barrels.mjs` and require zero unapproved
   workspace package subpath references.

## Generated Declaration Files in Source

`rg --files packages/agent/src -g '*.d.ts' | wc -l` reports 298 declaration
files under `packages/agent/src`. Representative paths:

- `packages/agent/src/index.d.ts`
- `packages/agent/src/services/relationships-graph.d.ts`
- `packages/agent/src/runtime/pglite-error-compat.d.ts`
- `packages/agent/src/api/compat-utils.d.ts`
- `packages/agent/src/config/types.d.ts`

`packages/agent/package.json` exports type declarations from source paths:

- line 55: `"types": "./src/services/app-session-gate.d.ts"`
- line 65: `"types": "./src/security/*.d.ts"`
- line 75: `"types": "./src/services/*.d.ts"`
- line 88: `"types": "./dist/*.d.ts"`

This makes generated artifacts part of the public package surface and blocks a
simple delete. Cleanup plan:

1. Make package build emit all declarations under `dist`.
2. Change package exports to point only at `dist`.
3. Delete `packages/agent/src/**/*.d.ts`.
4. Add ignore rules or generation cleanup so declarations are not regenerated
   into source.
5. Validate `bun run --cwd packages/agent build`, package dry-run, and at least
   one downstream package typecheck.

## Plugin Social Alpha Cleanup Findings

This package has concentrated slop that should be handled as a package-focused
cleanup, not a blind file delete.

| Path | Finding | Required cleanup |
| --- | --- | --- |
| `plugins/plugin-social-alpha/package.json` | `lint`, `format`, and `typecheck` scripts are skipped with `echo`. | Restore real lint/typecheck gates before relying on root validation. |
| `plugins/plugin-social-alpha/src/mockPriceService.ts` | Production source re-exports from `./__tests__/mocks/mockPriceService`. | Move mock types/fixtures out of production source or make the service real. |
| `plugins/plugin-social-alpha/src/simulationActors.ts` | Stub/backward-compatible actor parser; `parseDiscordDataToActors()` returns `[]`. | Replace with real parser or delete after call sites move to `simulationActorsV2`. |
| `plugins/plugin-social-alpha/src/services/TrustScoreService.ts` | Duplicate `private simulationService` declaration. | Fix after real typecheck is enabled. |
| `plugins/plugin-social-alpha/src/services/PriceDataService.ts` | Duplicate `private runtime` declaration. | Fix after real typecheck is enabled. |
| `plugins/plugin-social-alpha/src/services/historicalPriceService.ts` | Duplicate `private runtime` declaration. | Fix after real typecheck is enabled. |
| `plugins/plugin-social-alpha/src/services/priceEnrichmentService.ts` | Duplicate `private runtime` declaration. | Fix after real typecheck is enabled. |
| `plugins/plugin-social-alpha/src/services/index.ts`, `SimulationService.ts`, `PriceDataService.ts`, `TrustScoreService.ts` | Comments and naming still describe "Consolidated" services and backward-compatible old services. | Rename to canonical service names once imports are stable; remove old service exports if no consumers remain. |

## Obsolete Naming Candidates

Only rename these after import/API checks; action IDs and package public names
may be behavior.

| Path or symbol | Why flagged | Risk |
| --- | --- | --- |
| `plugins/app-lifeops/src/actions/inbox-unified.ts` and `plugins/app-lifeops/test/inbox-unified-action.test.ts` | File name contains `unified`; action may expose `INBOX_UNIFIED`. | High. Action names can be planner/API contracts. Rename requires alias strategy and scenario tests. |
| `plugins/plugin-wallet/src/providers/unified-wallet-provider.ts` | File name contains `unified`; likely should become canonical wallet provider naming. | Medium. Check package exports and imports first. |
| `packages/benchmarks/lifeops-bench/tests/test_unified_telemetry.py` | Test file name contains `unified`. | Low. Benchmark naming only unless reports depend on the name. |
| `plugins/plugin-social-alpha/src/services/*` comments/classes | "Consolidated" names are transitional cleanup markers. | Medium. Package currently skips typecheck, so rename only after validation is restored. |
| `packages/agent/src/actions/plugin.ts`, `packages/agent/src/actions/memories.ts` comments | Comments describe consolidated umbrella actions. | Low to medium. The umbrella actions may be canonical; remove stale wording but do not rename action IDs without planner validation. |

## Implementation Waves

### Wave 1 - No-reference deletes

Delete only the high-confidence files/symbols:

- `plugins/app-lifeops/src/lifeops/entities/resolver-shim.ts`
- `packages/app-core/src/platform/agent-browser-stub.ts`
- `plugins/plugin-coding-tools/src/lib/execution-mode.ts`
- `plugins/plugin-shell/utils/executionMode.ts`
- `plugins/plugin-discord/compat.ts` dead runtime proxy symbols only

Validation:

```bash
rg -n 'resolver-shim|ContactResolverShim|createContactResolverShim|ResolvedContactShim' plugins/app-lifeops packages plugins test
rg -n 'agent-browser-stub|platform/agent-browser-stub' packages plugins
rg -n 'createCompatRuntime|addServerId' plugins/plugin-discord packages plugins
bun run lint
bun run typecheck
bun run build
```

### Wave 2 - Canonicalize shared imports

Migrate UI and app-core local-inference shims to
`@elizaos/shared/local-inference/*`, then delete the old package-local shim
files.

Validation:

```bash
rg -n 'services/local-inference/(catalog|paths|routing-preferences|types|verify)' packages/ui/src packages/app-core/src
bun run --cwd packages/ui typecheck
bun run --cwd packages/app-core typecheck
bun run build
```

### Wave 3 - Test helper import cleanup

Rewrite root `test/helpers/*` imports to the canonical
`packages/app-core/test/helpers/*` implementations or create a real shared test
helper package.

Validation:

```bash
rg -n '../../../test/helpers|../../../../test/helpers|test/helpers/(http|live-provider|live-child-env)' packages plugins test
bun run test -- --runInBand
```

If the full test suite still hangs in app-core/Electrobun zero-test workers,
record the blocker and run the affected live/e2e subsets explicitly.

### Wave 4 - LifeOps and Health contracts

Collapse Wave-1 stubs into real contracts while preserving the AGENTS
invariants:

- One task primitive: `ScheduledTask`.
- Behavior is structural, not `promptInstructions` string matching.
- Health contributes through registries and does not import LifeOps internals.
- Connector/channel dispatch returns typed `DispatchResult`, not boolean.

Validation:

```bash
bun run lint:default-packs
rg -n 'wave1-types|contract-stubs|RoutineSeedTemplate|seed-routines' plugins/app-lifeops/src plugins/plugin-health/src
bun run --cwd plugins/app-lifeops test
bun run --cwd plugins/plugin-health test
bun run typecheck
```

### Wave 5 - Public export-map contraction

Remove wildcard/subpath exports package by package after internal imports are
clean.

Validation:

```bash
node scripts/audit-package-barrels.mjs
bun run build
npm pack --dry-run
```

For each package, inspect the generated tarball and verify no internal shim or
compat file is published unless deliberately supported.

### Wave 6 - Behaviorful stubs and compat route decisions

Do not delete these by grep. Either implement the real behavior, disable the
feature, or formally retire the API.

Validation must be route-specific:

- API route contract tests for app-core, elizacloud, computeruse, steward, and
  wallet compat routes.
- Cloud worker tests after removing worker stubs.
- Payment E2E tests after replacing `stub.invalid` adapters.
- Streaming session tests after replacing `mintStubSession()`.

## Final Validation Matrix

Before any cleanup PR is signed off:

```bash
git diff --check
bun run lint
bun run typecheck
bun run build
node scripts/audit-package-barrels.mjs
```

Known validation caveats from the broader cleanup run:

- `bun run knip` is blocked locally by the macOS native
  `@oxc-resolver/binding-darwin-arm64` code-signature/native-binding failure
  under Node v24.14.0.
- `bun run test` has previously hung in app-core Vitest/Electrobun zero-test
  workers. Treat full-suite green as unresolved until that runner issue is
  fixed or isolated.

Signoff requirements:

1. Fresh reference scans show no internal imports of the deleted path or symbol.
2. Package build/typecheck succeeds for every package whose exports changed.
3. Root lint/typecheck/build succeeds.
4. Route or E2E tests cover every behaviorful compatibility path that was
   retired.
5. For LifeOps/Health, `ScheduledTask` remains the only task primitive and
   Health remains registry-based.
