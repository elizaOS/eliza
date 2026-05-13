# Package Boundaries, Barrels, Shims, and Compatibility Surfaces

Date: 2026-05-12
Scope: read-only audit of package boundaries, barrels/re-exports, shims, stubs, fallback/legacy/deprecated files, duplicated routes/services, and imports that cross package internals instead of public APIs.

## Executive Summary

The repo has three recurring cleanup themes:

1. Several packages publish wildcard subpath exports (`"./*"`) or test/build aliases that resolve directly into `src`. These make internal modules act like public API and hide boundary violations.
2. Compatibility routes are clustered in `packages/app-core`, `cloud/apps/api`, `plugins/app-steward`, `plugins/plugin-computeruse`, and `plugins/plugin-elizacloud`. Some are likely intentional migration surfaces, but they should have owners, consumers, and removal criteria.
3. There are many shims/stubs for mobile, Electrobun, browser builds, templates, and tests. Most are not no-op deletions; the safe cleanup path is to separate build-target shims from stale migration shims and validate each with package-specific build/typecheck/test commands.

## Cross-Cutting Findings

### Root path aliases turn internals into imports

Refs:
- `tsconfig.json:24-33`
- `vitest.config.ts:25-55`

Finding: root TypeScript and Vitest aliases map `@elizaos/ui/*`, `@elizaos/core/*`, `@elizaos/shared/*`, `@elizaos/app-wallet/*`, `@elizaos/app-core/*`, and `@elizaos/agent/*` directly to package `src` trees. This makes private implementation files importable under package-looking specifiers.

Removal: needs migration. Do not remove aliases before public subpaths are explicit and imports are migrated to root/public barrels.

Risk: high. Alias removal will expose imports that currently compile only because test/dev resolution bypasses package `exports`.

Validation:
- `bun run typecheck`
- `bun run test:server`
- `bun run test:client`
- `bun run audit:package-barrels:check`

### Wildcard package exports preserve unstable public surfaces

Refs:
- `packages/agent/package.json:50-90`
- `packages/ui/package.json:39-53`
- `packages/shared/package.json:40-75` and its trailing `./*` export
- many plugin package manifests use `"./*.css"` plus `"./*"` exports.

Finding: wildcard exports make every built file a supported import path. This keeps compatibility but blocks meaningful package-boundary enforcement.

Removal: needs migration. Replace wildcard exports with explicit subpaths only after import inventory is clean.

Risk: high for published packages; medium inside monorepo if all callers are migrated together.

Validation:
- `bun run audit:package-barrels`
- `bun run typecheck:dist`
- `bun run publish:dry-run`

## Package-By-Package Findings

### `@elizaos/agent`

Refs:
- `packages/agent/package.json:50-90`
- `packages/agent/src/api/*.d.ts` and `packages/agent/src/api/*.d.ts.map` generated declaration artifacts; `find packages/agent/src/api -maxdepth 1 \( -name '*.d.ts' -o -name '*.d.ts.map' \) | wc -l` reported 192 files.
- `packages/agent/scripts/mobile-stubs/*.cjs`
- `packages/agent/src/api/music-player-route-fallback.ts`
- `packages/agent/src/cli/mobile-fs-shim.ts`
- `packages/agent/src/runtime/pglite-error-compat.ts`
- `packages/agent/src/services/version-compat.ts`

Finding: `@elizaos/agent` is both a runtime package and a source-resolved package. Its exports include `./services/*`, `./security/*`, and a final `./*`, while Vitest aliases all `@elizaos/agent/*` imports to source. Generated `.d.ts` artifacts inside `src/api` are source-tree pollution and make it harder to distinguish source from build output.

Removal: generated declarations are likely no-op cleanup after confirming they are not checked into an expected fixture path. Mobile stubs and compatibility files need migration because the mobile bundle and old route clients likely depend on them.

Risk: high for wildcard export contraction; low-to-medium for generated declaration cleanup if `git ls-files packages/agent/src/api/*.d.ts` confirms tracked generated files.

Validation:
- `bun run --cwd packages/agent typecheck`
- `bun run --cwd packages/agent build:dist`
- `bun run --cwd packages/agent build:mobile`
- `bun run --cwd packages/agent test`

### `@elizaos/app-core`

Refs:
- `packages/app-core/package.json:47-74`
- `packages/app-core/src/api/automations-compat-routes.ts`
- `packages/app-core/src/api/database-rows-compat-routes.ts`
- `packages/app-core/src/api/dev-compat-routes.ts`
- `packages/app-core/src/api/local-inference-compat-routes.ts`
- `packages/app-core/src/api/workbench-compat-routes.ts`
- `packages/app-core/src/platform/empty-node-module.ts`
- `packages/app-core/src/ui-compat.ts`
- `packages/app-core/platforms/electrobun/src/bridge/electrobun-stub.ts`
- `packages/app-core/platforms/electrobun/src/__stubs__/bun-ffi.ts`
- `packages/app-core/platforms/electrobun/src/__stubs__/electrobun-bun.ts`

Finding: `app-core` has a tighter export map than `agent`, but root Vitest aliases expose every internal file during tests. The package also owns several `*-compat-routes.ts` files that duplicate newer route families.

Removal: compatibility routes need migration with route-client evidence. `empty-node-module` and Electrobun stubs are build-target shims, not no-op removals.

Risk: high for route removal because external clients may call old paths; medium for tightening aliases; low for documenting stubs as intentional.

Validation:
- `bun run --cwd packages/app-core typecheck`
- `bun run --cwd packages/app-core test`
- `bun run test:ui:playwright`
- `bun run build:client`

### `@elizaos/ui`

Refs:
- `packages/ui/package.json:39-53`
- `packages/ui/src/api/agent-client-type-shim.ts`
- `packages/ui/src/platform/empty-node-module.ts`
- `packages/ui/src/types/index.ts`
- imports observed from apps/plugins: `@elizaos/ui/api/client-types-cloud`, `@elizaos/ui/config/app-config`, `@elizaos/ui/onboarding-config`, `@elizaos/ui/navigation`, `@elizaos/ui/i18n`.

Finding: `ui` explicitly exports a few subpaths, then falls back to `./*`. Callers import deeper subpaths such as navigation and i18n through the wildcard, so those modules are de facto public without package.json ownership.

Removal: needs migration. Make every intended public subpath explicit; then remove `./*` only after updating imports or root barrels.

Risk: medium-to-high because UI plugin packages rely on subpath imports.

Validation:
- `bun run --cwd packages/ui typecheck`
- `bun run --cwd packages/ui test`
- `bun run test:client`
- `bun run typecheck:dist`

### `@elizaos/shared`

Refs:
- `packages/shared/package.json:40-75` plus wildcard export after `./runtime-env`
- `packages/shared/src/contracts/index.ts`
- `packages/shared/src/config/index.ts`
- `packages/shared/src/utils/sql-compat.ts`
- `packages/shared/src/utils/index.ts`
- import observed: `@elizaos/shared/contracts/cloud-coding-containers`.

Finding: `shared` has large contract/config/utils barrels and a wildcard export. Cloud packages import specific contract internals through the wildcard. This is probably useful, but it means `shared` is acting as both stable contract package and misc utility bucket.

Removal: needs migration. Keep contract subpaths public, but make them explicit and avoid exporting all `utils`.

Risk: medium. Contract consumers should be easy to validate, but utility consumers may be scattered.

Validation:
- `bun run --cwd packages/shared typecheck`
- `bun run --cwd packages/shared test`
- `bun run typecheck:cloud`

### `@elizaos/plugin-sql`

Refs:
- `plugins/plugin-sql/package.json:1-61`
- `plugins/plugin-sql/src/package.json:1-41`

Finding: `plugin-sql` has two package manifests with the same package name but different versions and export roots. The top-level package publishes from `src/dist`, while `src/package.json` describes a nested package publishing from `dist`. This is a strong boundary smell and can confuse workspace tooling, publishing, and import resolution.

Removal: needs migration. Do not delete either manifest until build/publish scripts are normalized around one package root.

Risk: high. This affects package publishing and runtime export paths.

Validation:
- `bun run --cwd plugins/plugin-sql typecheck`
- `bun run --cwd plugins/plugin-sql build`
- `bun run --cwd plugins/plugin-sql test`
- `bun run publish:dry-run`

### `cloud/*`

Refs:
- `cloud/apps/api/compat/**`
- `cloud/packages/lib/api/compat-envelope.ts`
- `cloud/packages/lib/eliza/runtime/database/adapter-compat.ts`
- `cloud/packages/lib/services/app-domains-compat.ts`
- `cloud/apps/api/src/stubs/*.ts`
- `cloud/apps/api/types/workspace-shims.d.ts`
- `cloud/packages/types/workspace-shims.d.ts`
- `cloud/apps/frontend/src/shims/*`

Finding: Cloud has a full `compat` API tree for agents/jobs/availability plus library compatibility envelopes and service adapters. It also has package stubs and workspace shims for app builds.

Removal: compatibility API routes need migration and traffic/consumer proof. Build stubs/shims are not no-op removals unless replaced by proper package deps or conditional imports.

Risk: high for `cloud/apps/api/compat/**`; medium for shims.

Validation:
- `bun run --cwd cloud typecheck`
- `bun run --cwd cloud test`
- `bun run --cwd cloud verify`

### App Plugins

Refs:
- hosted app imports: `plugins/app-scape/src/index.ts`, `plugins/app-2004scape/src/index.ts`, `plugins/app-companion/src/plugin.ts`, `plugins/app-screenshare/src/index.ts` import `@elizaos/agent/services/app-session-gate`.
- broad app barrels: `plugins/app-companion/src/index.ts`, `plugins/app-training/src/index.ts`, `plugins/app-task-coordinator/src/index.ts`, `plugins/app-shopify/src/index.ts`, `plugins/app-polymarket/src/index.ts`, `plugins/app-vincent/src/index.ts`.
- compat routes: `plugins/app-steward/src/routes/*compat-routes.ts`.

Finding: apps commonly export broad UI/service barrels and rely on agent service subpaths. `app-session-gate` is explicitly exported, so those imports are legitimate today, but the pattern reinforces service-subpath coupling across package boundaries.

Removal: broad barrels need migration only if package exports are tightened. Steward compat routes need consumer migration.

Risk: medium. App packages are likely consumed dynamically by the app shell and plugin loader.

Validation:
- `bun run test:client`
- `bun run test:plugins`
- `bun run --cwd plugins/app-steward test`

### Core Plugins

Refs:
- `plugins/plugin-computeruse/src/routes/computer-use-compat-routes.ts`
- `plugins/plugin-elizacloud/src/routes/cloud-compat-routes.ts`
- `plugins/plugin-music/src/route-fallback.ts`
- `plugins/plugin-discord/compat.ts`
- `plugins/plugin-workflow/src/lib/legacy-task-migration.ts`
- `plugins/plugin-workflow/src/lib/legacy-text-trigger-migration.ts`
- `plugins/plugin-mcp/src/tool-compatibility/**`
- `plugins/plugin-health/src/connectors/contract-stubs.ts`
- `plugins/plugin-health/src/default-packs/contract-stubs.ts`

Finding: plugin compatibility files fall into three categories: old HTTP routes, runtime/model compatibility adapters, and contract stubs used to keep registry shapes stable. Only old HTTP routes look like removal candidates. Contract stubs and legacy migrations should remain until data migration windows close.

Removal: mixed. Route fallbacks may be removable after endpoint inventory; legacy migrations and contract stubs need explicit sunset conditions.

Risk: medium-to-high depending on plugin. Workflow legacy migrations carry data-loss risk if removed early.

Validation:
- `bun run test:plugins`
- targeted package tests, for example `bun run --cwd plugins/plugin-workflow test`
- LifeOps/health packs: `bun run lint:default-packs` where applicable

### Native Plugins

Refs:
- many `packages/native-plugins/*/src/web.ts` files implement web fallbacks.
- package manifests describe browser fallbacks, for example `packages/native-plugins/calendar/package.json`, `contacts/package.json`, `messages/package.json`, `wifi/package.json`, `talkmode/package.json`.
- prior cleanup ledger already flags some Electrobun stubs in `docs/porting/CLEANUP-LEDGER.md`.

Finding: native plugin web fallbacks are intentional Capacitor surfaces, not dead files by default. They often provide graceful unsupported behavior in browser/Electrobun contexts.

Removal: generally needs migration. Only package-specific dead stubs identified by knip and build owners should be removed.

Risk: medium. Removing a web fallback can break desktop/web builds even if native platforms work.

Validation:
- targeted native package build/test
- `bun run build:client`
- mobile/desktop smoke relevant to the plugin

### CLI Templates and Examples

Refs:
- `packages/elizaos/templates/project/apps/app/src/native-plugin-stubs.ts`
- `packages/elizaos/templates/project/apps/app/src/optional-eliza-app-stub.tsx`
- `packages/elizaos/templates/project/apps/app/src/type-stubs/**`
- `packages/elizaos/templates/project/scripts/ensure-elizaos-optional-app-stubs.mjs`
- example stubs under `packages/examples/*/src/stubs` and `packages/examples/*/shims*`.

Finding: template stubs are compatibility scaffolding for generated projects. They should not be evaluated like runtime package dead code.

Removal: needs template migration. Removing stubs without updating generated projects will break `elizaos create` outputs.

Risk: medium.

Validation:
- `bun run --cwd packages/elizaos test`
- scaffold a template project and run its typecheck/build
- `bun run build:client`

## Imports Crossing Internals

Representative imports found:

- `packages/app-core/src/services/tool-call-cache/index.ts` imports `@elizaos/agent/runtime/tool-call-cache/index`.
- `packages/app-core/platforms/electrobun/src/native/permissions.ts` imports `@elizaos/agent/services/permissions/probers/index`.
- `packages/app/src/main.tsx` imports `@elizaos/ui/api/ios-local-agent-transport`, which is not an explicit `@elizaos/ui` export.
- `packages/app-core/src/api/dev-route-catalog.test.ts` imports `@elizaos/ui/navigation`, which is not an explicit `@elizaos/ui` export.
- `packages/app-core/test/helpers/i18n.ts` imports `@elizaos/ui/i18n`, which is not an explicit `@elizaos/ui` export.
- `cloud/packages/lib/services/coding-containers.ts` imports `@elizaos/shared/contracts/cloud-coding-containers`, which relies on the `@elizaos/shared` wildcard export.

Migration direction: convert recurring internal imports to explicit public exports, then remove wildcard access. Where a dependency is truly internal, keep it relative within the package instead of importing through the published package name.

## Prioritized TODOs

1. Inventory wildcard subpath imports with a script and fail CI for new ones outside an allowlist.
2. Make `@elizaos/ui` public subpaths explicit for current real consumers (`api/client-types-cloud`, `config/app-config`, `onboarding-config`, plus decide on `navigation`, `i18n`, and `api/ios-local-agent-transport`).
3. Normalize `@elizaos/plugin-sql` to a single package root and one export map before publishing changes.
4. Decide owners and sunset criteria for each compatibility route cluster: `packages/app-core/src/api/*compat-routes.ts`, `cloud/apps/api/compat/**`, `plugins/app-steward/src/routes/*compat-routes.ts`, `plugins/plugin-computeruse/src/routes/computer-use-compat-routes.ts`, and `plugins/plugin-elizacloud/src/routes/cloud-compat-routes.ts`.
5. Remove or relocate generated declaration artifacts from `packages/agent/src/api` after confirming build output is not intentionally tracked there.
6. Split shim/stub inventory into build-target shims, test stubs, template scaffolding, and stale migration shims. Only the stale migration group should be removal candidates.
7. Replace root/test aliases that map `@elizaos/*/*` to `src/*` with generated aliases derived from package `exports`, then run `bun run typecheck`, `bun run test:server`, and `bun run test:client`.
8. Run `bun run audit:package-barrels:check` and use its output to ratchet explicit export maps package by package.
