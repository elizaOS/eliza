# Phase 4 Package Boundaries

Dry-run audit only. No package files, source files, manifests, or build files were modified for this report.

## Scope

This pass examined package boundaries across root workspaces, nested cloud workspaces, package manifests, TypeScript path aliases, build metadata, exports, cross-package imports, and dependency declarations.

Primary commands used:

```sh
rg --files -g 'package.json' -g '!node_modules' -g '!**/dist/**' -g '!**/build/**' -g '!**/.turbo/**'
rg --files -g 'tsconfig*.json' -g '!node_modules' -g '!**/dist/**' -g '!**/build/**' -g '!**/.turbo/**'
PATH=/Users/shawwalters/.bun/bin:$PATH bun run fix-deps:check
```

Inventory counts from this pass:

- `238` `package.json` files found after excluding `node_modules`, `dist`, `build`, `.turbo`, and vendored `packages/inference/llama.cpp`.
- `201` root workspace packages according to `scripts/fix-workspace-deps.mjs`.
- `17` cloud-only packages are under `cloud/package.json` workspaces but not root `package.json` workspaces.
- `20` named packages are not in either root or cloud workspaces, mostly templates, benchmark nested tools, vendored Solidity packages, and `plugins/plugin-sql/src`.
- `179` cross-workspace imports refer to a workspace package not declared in the importing package manifest.
- `196` relative imports cross package boundaries.
- `384` source-state dependency spec issues were reported by `bun run fix-deps:check`.

## Executive Findings

### 1. Source Manifests Drifted Away From `workspace:*`

The repo's own `scripts/fix-workspace-deps.mjs` says committed source state should use `workspace:*` for local package edges. `PATH=/Users/shawwalters/.bun/bin:$PATH bun run fix-deps:check` currently fails with `384 issue(s) found`.

High-impact examples:

- `packages/app/package.json` pins dozens of local app, plugin, native-plugin, shared, UI, and agent packages to `2.0.0-beta.*`.
- `packages/agent/package.json` pins core, shared, plugin, native-plugin, and skill packages instead of `workspace:*`.
- `packages/app-core/package.json` pins `@elizaos/agent`, `@elizaos/core`, `@elizaos/shared`, `@elizaos/ui`, `@elizaos/vault`, and many plugins instead of `workspace:*`.
- `packages/ui/package.json` pins `@elizaos/core`, `@elizaos/plugin-browser`, and `@elizaos/shared`.
- `plugins/app-lifeops/package.json` pins LifeOps dependencies, including health, app-core, shared, UI, core, and connector plugins.
- Many plugin packages pin `@elizaos/core` in `dependencies`, `devDependencies`, and/or `peerDependencies`.

TODO:

- Run `PATH=/Users/shawwalters/.bun/bin:$PATH bun run fix-deps` as a dedicated manifest-only cleanup.
- Review the diff for intentional publish/deploy exceptions before accepting it.
- Re-run `PATH=/Users/shawwalters/.bun/bin:$PATH bun run fix-deps:check` and require zero issues before package-boundary signoff.
- After fixing manifests, run `PATH=/Users/shawwalters/.bun/bin:$PATH bun install` only if the lockfile must be synchronized.

Risk:

- Medium. This is mechanically supported by the repo script, but it touches many manifests and likely the lockfile. Keep it separate from code movement.

### 2. Root And Cloud Workspace Graphs Overlap But Are Not Unified

Root `package.json` workspaces include:

- `packages/*`
- selected benchmark and example globs
- `packages/native-plugins/*`
- `packages/app-core/platforms/*`
- `packages/app-core/deploy/cloud-agent-template`
- `plugins/*`
- `cloud/packages/sdk`

`cloud/package.json` defines a nested workspace root with:

- `../packages/*`
- `../packages/native-plugins/*`
- `../plugins/*`
- `apps/*`
- `packages/*`
- `packages/services/*`
- `services/*`
- `examples/*`

Cloud-only packages not included in root workspaces:

- `cloud/services/agent-server` as `@elizaos/agent-server`
- `cloud/services/operator` as `@elizaos/operator`
- `cloud/services/gateway-discord` as `@elizaos/gateway-discord`
- `cloud/services/_smoke-mcp` as `cloud-mcp-smoke`
- `cloud/services/gateway-webhook` as `@elizaos/gateway-webhook`
- `cloud/services/rtmp-relay` as `@elizaos/cloud-rtmp-relay`
- `cloud/services/container-control-plane` as `@elizaos/container-control-plane`
- `cloud/apps/api` as `@elizaos/cloud-api`
- `cloud/apps/frontend` as `@elizaos/cloud-frontend`
- `cloud/packages/billing` as `@elizaos/billing`
- `cloud/packages/db` as `@elizaos/cloud-db`
- `cloud/packages/lib` as `@elizaos/cloud-lib`
- `cloud/packages/types` as `@elizaos/cloud-types`
- `cloud/packages/ui` as `@elizaos/cloud-ui`
- `cloud/examples/edad` as `@elizaos/example-edad`
- `cloud/examples/clone-ur-crush` as `@elizaos/example-clone-ur-crush`
- `cloud` as `@elizaos/cloud`

TODO:

- Decide whether cloud is intentionally a nested workspace root or should be first-class in the root workspace graph.
- If nested is intentional, document this in root `README.md` or `cloud/README.md` and keep cloud validation under `bun run --cwd cloud ...`.
- If unified is desired, add cloud workspace globs to root `package.json` and adjust root `turbo.json` so cloud apps/services build and typecheck through one graph.
- Do not leave only `cloud/packages/sdk` in the root graph without an explanation; it creates a partial cloud boundary that is easy to misread.

Risk:

- Medium to high. Cloud has its own install/build assumptions. Unifying it may alter dependency resolution and CI time.

### 3. Missing Declared Workspace Dependencies

The import scan found `179` imports of workspace packages that are not declared in the importing package's manifest. Some are test-only and should become `devDependencies`; some are runtime and should become `dependencies` or be removed by moving code to the correct owner.

Runtime missing dependency groups:

- `cloud/packages/lib` (`@elizaos/cloud-lib`) imports `@elizaos/core` `79` times without declaring it.
  - Examples: `cloud/packages/lib/debug/store.ts`, `cloud/packages/lib/debug/collector.ts`, `cloud/packages/lib/debug/types.ts`, `cloud/packages/lib/debug/plugin.ts`.
- `cloud/packages/db` (`@elizaos/cloud-db`) imports `@elizaos/core` `5` times without declaring it.
  - Examples: `cloud/packages/db/repositories/agents/rooms.ts`, `agents/index.ts`, `agents/agents.ts`, `agents/memories.ts`, `agents/entities.ts`.
- `cloud/packages/lib` imports `@elizaos/cloud-ui` `5` times without declaring it.
  - Examples: `cloud/packages/lib/fragments/eliza-sdk.ts`, `cloud/packages/lib/prompts/sdk.ts`, `prompts/index.ts`, `prompts/rules.ts`, `prompts/templates.ts`.
- `packages/examples/browser-extension` imports `@elizaos/core`, provider plugins, and `@elizaos/plugin-localdb` from runtime files without declaring them.
  - Examples: `packages/examples/browser-extension/shared/eliza-runtime-full.ts`, `shared/eliza-runtime.ts`, `shared/providers/pageContentProvider.ts`.
- `packages/agent` imports app/plugin packages without declaring them:
  - `@elizaos/plugin-telegram` from `src/api/server-types.ts` and `server-types.d.ts`.
  - `@elizaos/app-contacts`, `@elizaos/app-phone`, and `@elizaos/app-wifi` from `src/runtime/android-app-plugins.ts`.
  - `@elizaos/plugin-agent-orchestrator` and `@elizaos/plugin-shell` from `src/runtime/eliza.ts`.
  - `@elizaos/app-task-coordinator` from `src/api/server-helpers-swarm.d.ts`.
- `plugins/plugin-app-control` imports `@elizaos/shared` from runtime files without declaring it.
  - `plugins/plugin-app-control/src/services/app-registry-service.ts`
  - `plugins/plugin-app-control/src/actions/app-load-from-directory.ts`
- `plugins/plugin-elizacloud` imports `@elizaos/shared` from runtime files without declaring it.
  - `plugins/plugin-elizacloud/src/routes/cloud-coding-container-routes.ts`
  - `plugins/plugin-elizacloud/src/types/cloud.ts`
- `plugins/app-steward` imports `@elizaos/app-lifeops` from `plugins/app-steward/src/api/binance-skill-helpers.ts` without declaring it.
- `cloud/apps/api` imports `@elizaos/core` from `cloud/apps/api/v1/documents/_worker-documents.ts` without declaring it.
- `cloud/packages/lib` imports `@elizaos/plugin-elevenlabs`, `@elizaos/plugin-elizacloud`, `@elizaos/shared`, and `@elizaos/plugin-sql` without declaring them.
- `cloud/packages/types` imports `@elizaos/core` from `cloud/packages/types/workspace-shims.d.ts` without declaring it.
- `packages/app-core/platforms/electrobun` imports `@elizaos/agent/services/permissions/probers/index` from `src/native/permissions.ts` without declaring `@elizaos/agent`.
- `packages/shared` imports `@elizaos/app-core` from `packages/shared/src/config/app-config.ts` without declaring it. This is also an ownership smell because shared should not depend upward on app-core.
- `packages/ui` imports `@elizaos/app-core` from `packages/ui/src/config/app-config.ts` without declaring it. This may be intentional only if app config belongs outside UI.

Test/script missing dependency groups:

- `packages/app-core` imports `@elizaos/app-lifeops`, app plugins, and provider plugins from test helpers and benchmark runners without declaring test-time dependencies.
- `packages/core` imports `@elizaos/plugin-agent-orchestrator`, `@elizaos/plugin-sql`, `@elizaos/agent`, and `@elizaos/plugin-elizacloud` from live tests/helpers without declaring them.
- `plugins/plugin-app-control` imports `@elizaos/scenario-schema` from scenario tests without declaring it.
- `packages/benchmarks/framework/typescript` imports `@elizaos/core` and `@elizaos/plugin-openai` without declaring them.
- `packages/benchmarks/configbench` imports provider plugins and `@elizaos/plugin-sql` without declaring them.
- `plugins/app-task-coordinator`, `plugins/plugin-discord`, and `plugins/plugin-openrouter` import sibling plugins from live/unit tests without declaring test-time dependencies.

TODO:

- For each runtime group, either add the missing package to `dependencies` or move the imported symbol to the importing package's real owner.
- For each test/script group, add `devDependencies` only if the cross-package dependency is intentional.
- Prefer changing imports to public package entrypoints over adding dependencies for source/test helper deep imports.
- Re-run the missing-dependency scanner after manifest cleanup and require zero runtime misses.

Suggested validation:

```sh
PATH=/Users/shawwalters/.bun/bin:$PATH bun run fix-deps:check
PATH=/Users/shawwalters/.bun/bin:$PATH bun run typecheck
PATH=/Users/shawwalters/.bun/bin:$PATH bun run --cwd cloud typecheck
```

### 4. Runtime Code Crosses Package Boundaries With Relative Imports

The scan found `196` relative imports that resolve into a different package. Many are tests using shared helpers, but several are runtime/package-boundary violations.

Highest-priority runtime violations:

- `packages/app-core/src/services/tool-call-cache/index.ts` imports `../../../../agent/src/runtime/tool-call-cache/index.ts`.
  - TODO: move tool-call-cache contracts/implementation into `packages/shared` or expose a narrow public subpath from `@elizaos/agent`.
  - Validation: `bun run --cwd packages/app-core typecheck`, `bun run --cwd packages/agent typecheck`, and tests around tool-call caching.
- `cloud/packages/lib/services/coding-containers.ts` imports `../../../../packages/shared/src/contracts/cloud-coding-containers`.
  - TODO: export this contract from `@elizaos/shared` and import by package name.
  - Also add `@elizaos/shared` to `cloud/packages/lib/package.json`.
- `cloud/packages/db/repositories/containers.ts` imports cloud-lib constants and storage modules via `../../lib/...`.
  - TODO: either declare `@elizaos/cloud-lib` and import public subpaths, or move DB-owned constants/storage contracts into `cloud/packages/db` or `cloud/packages/types`.
- `cloud/packages/db/helpers.ts` imports `../helpers` from the root `cloud` package.
  - TODO: invert this dependency. A leaf DB package should not import the cloud root package.
- `cloud/packages/lib/providers/CreditsProvider.tsx` imports `../../ui/src/runtime/navigation`.
  - TODO: export `runtime/navigation` from `@elizaos/cloud-ui` or move the provider into cloud UI.
- `cloud/packages/types/cloud-worker-env.ts` imports `../lib/storage/r2-runtime-binding`.
  - TODO: move worker-env type dependencies into `cloud/packages/types` or export a type-only public subpath from cloud-lib.
- `plugins/app-companion/src/components/companion/CompanionView.tsx` and `CompanionAppView.tsx` import `../../../../app-task-coordinator/src/PtyConsoleSidePanel`.
  - TODO: export this component from `@elizaos/app-task-coordinator` or move it into a shared UI package.
- `plugins/app-training/src/cli/train.ts` and `src/core/training-orchestrator.ts` import `../../../app-lifeops/test/helpers/lifeops-eval-model.ts`.
  - TODO: move `lifeops-eval-model` out of LifeOps tests into a shared evaluation/benchmark helper package.
- `packages/scenario-runner/src/judge.ts` imports `../../../plugins/app-lifeops/test/helpers/lifeops-eval-model.ts`.
  - TODO: same as above; runtime scenario-runner must not depend on another package's test helper.
- `packages/inference/verify/asr_bench.ts` imports `../../app-core/src/services/local-inference/voice/ffi-bindings`.
  - TODO: expose a stable local-inference FFI verification contract or move the ASR benchmark next to app-core ownership.
- `packages/ui/src/types/index.ts` imports `../../../shared/src/types/index`.
  - TODO: import `@elizaos/shared` or an exported shared subpath instead.
- `packages/examples/browser-extension/chrome/src/*` imports `../../shared/*` from sibling example package `packages/examples/browser-extension`.
  - TODO: either make the shared browser-extension code a real workspace package or keep the chrome/safari apps under one package root.
- `plugins/plugin-sql/src/build.ts` imports parent package files such as `../index.node.js`.
  - TODO: remove the nested `plugins/plugin-sql/src/package.json` package boundary or rename it so tools do not see two `@elizaos/plugin-sql` packages.
- `plugins/plugin-feishu/build.ts` and `plugins/plugin-inmemorydb/build.ts` import `../../packages/core/build`.
  - TODO: expose build helpers through a script/tool package or duplicate the tiny build wrapper locally if that is less coupling.

Lower-risk but still cleanup-worthy test/helper crossings:

- LifeOps tests import app-core test helpers.
- App-core tests import core, agent, UI, LifeOps, app, and plugin internals.
- Cloud root tests import cloud app internals.
- Provider plugin live tests import app-core live helpers.
- Plugin workflow credential-provider tests import source files from many social plugins.

TODO:

- Create a `test/helpers` package or shared test-support package for live runtime helpers if these helpers are meant to be reused.
- For product runtime code, forbid `../..` imports into sibling package roots.
- Add a lightweight boundary audit script that fails on runtime relative imports crossing package roots while allowing an explicit test-helper allowlist.

Suggested validation:

```sh
rg -n "\\.\\./\\.\\./\\.\\./\\.\\./packages/|\\.\\./\\.\\./\\.\\./plugins/" packages plugins cloud -g '*.{ts,tsx,js,jsx,mjs,cjs}'
PATH=/Users/shawwalters/.bun/bin:$PATH bun run typecheck
PATH=/Users/shawwalters/.bun/bin:$PATH bun run --cwd cloud typecheck
```

### 5. Duplicate Package Names Confuse Ownership

Duplicate names found:

- `@elizaos/plugin-sql`
  - `plugins/plugin-sql/package.json`
  - `plugins/plugin-sql/src/package.json`
- `@elizaos/plugin-starter`
  - `packages/elizaos/templates/plugin/package.json`
  - `packages/examples/_plugin/package.json`

TODO:

- Remove the nested `plugins/plugin-sql/src/package.json` if it is only a build implementation detail, or rename it/private-scope it so package scanners do not identify it as a second package with the same name.
- For templates/examples, replace real package names with placeholders or mark the example/template as private and ensure it is excluded from package publication workflows.

Risk:

- Medium for plugin-sql because its build scripts intentionally run from `src`.
- Low for template/example names if publication tooling already excludes them, but the duplicate still pollutes audit tooling.

### 6. Some Named Packages Are Outside Both Workspace Graphs

Packages not included by root or cloud workspaces:

- Templates: `packages/elizaos/templates/min-project`, `packages/elizaos/templates/project`, `packages/elizaos/templates/project/apps/app`, `packages/elizaos/templates/project/apps/app/electrobun`, `packages/elizaos/templates/min-plugin`, `packages/elizaos/templates/plugin`.
- `plugins/plugin-sql/src`.
- `plugins/plugin-minecraft/mineflayer-server`.
- Registry site: `packages/registry/site`.
- Benchmark nested packages: `packages/benchmarks/personality-bench`, `packages/benchmarks/framework/typescript`, `packages/benchmarks/configbench`, Solana/EVM/Gauntlet nested packages.
- Vendored Solidity packages under `packages/app-core/test/contracts/lib/openzeppelin-contracts`.

TODO:

- Make a deliberate include/exclude table for non-workspace packages.
- Exclude vendored/test-contract package manifests from repo-wide package audits.
- Decide if `packages/benchmarks/personality-bench`, `packages/benchmarks/framework/typescript`, and `packages/benchmarks/configbench` should become root workspaces. They currently have imports/dependencies that look repo-integrated.
- Decide if `plugins/plugin-minecraft/mineflayer-server` is an internal implementation package or a publishable package.

### 7. Wide TypeScript `rootDir` And Path Maps Hide Boundary Violations

Several package tsconfigs compile from outside their package directory:

- `plugins/plugin-elizacloud/tsconfig.json` has `rootDir=../..`.
- `plugins/plugin-local-inference/tsconfig.json` has `rootDir=../../../`.
- `plugins/plugin-capacitor-bridge/tsconfig.json` has `rootDir=../../../`.
- `plugins/plugin-agent-orchestrator/tsconfig.json` has `rootDir=../..`.
- `plugins/plugin-app-control/tsconfig.json` has `rootDir=../../../`.
- `packages/core/tsconfig.json` has `rootDir=../../`.
- `packages/ui/tsconfig.build.json` has `rootDir=../../`.
- `packages/agent/tsconfig.build.json` has `rootDir=../..`.
- `packages/app-core/tsconfig.build.json` has `rootDir=../../`.
- `packages/app-core/platforms/electrobun/tsconfig.json` has `rootDir=../../../..`.
- `packages/examples/browser-extension/chrome/tsconfig.json` has `rootDir=../../../../`.

Large path alias maps also point directly to sibling source trees, especially in:

- `packages/agent/tsconfig.json`
- `packages/app-core/tsconfig.json`
- `packages/ui/tsconfig.json`
- `packages/scenario-runner/tsconfig.json`
- `plugins/plugin-mcp/tsconfig.json`
- `plugins/app-wifi/tsconfig.json`
- `plugins/app-contacts/tsconfig.json`
- `packages/app-core/platforms/electrobun/tsconfig.json`
- root `tsconfig.json`

TODO:

- Treat wide `rootDir` as a temporary build compatibility mechanism, not a normal package boundary.
- For each package, shrink `rootDir` to the package root or `src` after public exports are added for any needed cross-package imports.
- Avoid wildcard path aliases like `@elizaos/*` in package tsconfigs unless they resolve to package entrypoints, not sibling source files.
- Add a check that package build configs do not compile arbitrary sibling package source except from an explicit allowlist.

Risk:

- High if changed in bulk. These configs likely paper over existing cross-package imports. Fix imports and exports first, then tighten tsconfig.

### 8. Export Maps Are Broad And Encourage Deep Public Surfaces

Many packages use wildcard exports such as:

```json
"./*": {
  "import": "./dist/*.js",
  "default": "./dist/*.js",
  "types": "./dist/*.d.ts"
}
```

This pattern appears across most plugins and several packages, including `@elizaos/core`, `@elizaos/agent`, `@elizaos/shared`, `@elizaos/ui`, `@elizaos/scenario-runner`, and many `plugins/*`.

Source manifests sometimes export TypeScript sources for local Bun/dev usage, with publish manifests rewritten into `dist/package.json` by `scripts/prepare-package-dist.mjs`. This is not automatically wrong, but it makes boundary audits harder unless the source and publish contracts are both validated.

TODO:

- Keep wildcard exports only where the package explicitly promises subpath compatibility.
- For packages that should have a small public API, replace wildcard exports with named subpaths.
- Run `PATH=/Users/shawwalters/.bun/bin:$PATH bun run audit:package-barrels:check` before shrinking exports.
- For publishable packages, validate both source manifest and generated `dist/package.json`.
- Require `pack:dry-run` on changed publishable packages.

Suggested validation:

```sh
PATH=/Users/shawwalters/.bun/bin:$PATH bun run audit:package-barrels:check
PATH=/Users/shawwalters/.bun/bin:$PATH bun run --cwd packages/core build
PATH=/Users/shawwalters/.bun/bin:$PATH bun run --cwd packages/core pack:dry-run
PATH=/Users/shawwalters/.bun/bin:$PATH bun run --cwd packages/agent build
PATH=/Users/shawwalters/.bun/bin:$PATH bun run --cwd packages/agent pack:dry-run
```

### 9. Cloud Package Metadata Is Mixed Between App/Service And Library Conventions

Cloud services/apps often omit `exports`, `files`, and type metadata, which may be fine for deploy-only packages. Cloud libraries use private package manifests with source exports, for example:

- `cloud/packages/lib/package.json` exports `"."` as `./index.ts`.
- `cloud/packages/db/package.json` exports `"."` as `./index.ts`.
- `cloud/packages/types/package.json` exports only `./package.json`.
- `cloud/packages/ui/package.json` is publish-style with `dist`.

TODO:

- Classify every cloud package as one of:
  - deploy-only app/service,
  - private internal library,
  - publishable package.
- For deploy-only packages, mark `private: true` consistently.
- For private internal libraries, still declare all dependencies and export any public internal subpaths used by other cloud packages.
- For publishable packages, require `main`, `types`, `exports`, `files`, `build`, `typecheck`, and `pack:dry-run`.

### 10. Package Boundary Ownership Smells

These should be reviewed as architecture, not just manifests:

- `packages/shared` depends upward on `packages/app-core` via `packages/shared/src/config/app-config.ts`.
  - Shared should not know app-core. Move app config to shared if it is foundational, or move the shared file out of shared.
- `packages/ui` depends on app-core config through `packages/ui/src/config/app-config.ts`.
  - UI may need app config, but the canonical contract should live in shared or a dedicated config package.
- `packages/app-core` imports agent runtime implementation for tool-call cache.
  - Either app-core owns the cache service contract or agent exposes a public cache package/subpath.
- `plugins/app-training` and `packages/scenario-runner` import LifeOps test helpers at runtime.
  - Test helpers cannot be runtime dependencies. Move common evaluator/model code to a shared evaluation package.
- `plugins/app-companion` imports a source component from `plugins/app-task-coordinator`.
  - Either `app-task-coordinator` exports that component or shared UI owns it.
- `cloud/packages/db` depends on `cloud/packages/lib` implementation details and the cloud root.
  - DB should be leaf-ish. Shared cloud constants/types should move to `cloud/packages/types` or exported subpaths.

## Consolidated TODO List

### P0: Manifest Graph Correctness

1. Run `bun run fix-deps` and review the manifest-only diff.
2. Re-run `bun run fix-deps:check` until it passes.
3. Add missing runtime dependencies or remove the runtime imports listed in Finding 3.
4. Add missing test-only `devDependencies` only after confirming the test/helper import is intentional.
5. Eliminate duplicate package names, starting with `plugins/plugin-sql/src/package.json`.

### P1: Runtime Boundary Cleanup

1. Replace `packages/app-core` to `packages/agent/src/runtime/tool-call-cache` imports with a public package boundary.
2. Replace `cloud/packages/lib` to `packages/shared/src/contracts/cloud-coding-containers` with an exported shared subpath.
3. Remove cloud DB imports from cloud root and cloud-lib internals.
4. Move LifeOps eval helpers out of `plugins/app-lifeops/test`.
5. Export or relocate `PtyConsoleSidePanel` instead of importing `app-task-coordinator/src`.
6. Replace UI/shared relative source imports with package imports.

### P2: Workspace And Build Structure

1. Decide the cloud nested workspace strategy and document it.
2. Classify non-workspace package manifests as intentional or move them into a workspace graph.
3. Add package-boundary checks for relative imports crossing package roots.
4. Tighten tsconfig `rootDir` and path aliases after runtime imports are fixed.
5. Normalize cloud package metadata by package class.

### P3: Public API Surface

1. Inventory wildcard `./*` exports and decide which are real public API.
2. Replace broad wildcard exports with named subpaths where safe.
3. Validate generated `dist/package.json` for packages using source manifests plus `prepare-package-dist`.
4. Run pack dry-runs for any publishable package whose exports/files/main/types changed.

## Validation Plan

Baseline checks after manifest-only cleanup:

```sh
PATH=/Users/shawwalters/.bun/bin:$PATH bun run fix-deps:check
PATH=/Users/shawwalters/.bun/bin:$PATH bun run lint
PATH=/Users/shawwalters/.bun/bin:$PATH bun run typecheck
PATH=/Users/shawwalters/.bun/bin:$PATH bun run build
```

Cloud-specific checks:

```sh
PATH=/Users/shawwalters/.bun/bin:$PATH bun run --cwd cloud lint:check
PATH=/Users/shawwalters/.bun/bin:$PATH bun run --cwd cloud typecheck
PATH=/Users/shawwalters/.bun/bin:$PATH bun run --cwd cloud verify
```

Boundary checks:

```sh
PATH=/Users/shawwalters/.bun/bin:$PATH bun run audit:package-barrels:check
PATH=/Users/shawwalters/.bun/bin:$PATH bunx madge --circular --extensions ts,tsx --exclude '(dist|build|node_modules|.turbo|coverage|.claude|packages/inference/llama.cpp|packages/app-core/platforms/electrobun/build)' packages plugins test
rg -n "\\.\\./\\.\\./\\.\\./\\.\\./packages/|\\.\\./\\.\\./\\.\\./plugins/" packages plugins cloud -g '*.{ts,tsx,js,jsx,mjs,cjs}'
```

Targeted checks for the highest-risk boundary fixes:

```sh
PATH=/Users/shawwalters/.bun/bin:$PATH bun run --cwd packages/app-core typecheck
PATH=/Users/shawwalters/.bun/bin:$PATH bun run --cwd packages/agent typecheck
PATH=/Users/shawwalters/.bun/bin:$PATH bun run --cwd packages/shared typecheck
PATH=/Users/shawwalters/.bun/bin:$PATH bun run --cwd packages/ui typecheck
PATH=/Users/shawwalters/.bun/bin:$PATH bun run --cwd plugins/app-lifeops typecheck
PATH=/Users/shawwalters/.bun/bin:$PATH bun run --cwd plugins/app-training typecheck
PATH=/Users/shawwalters/.bun/bin:$PATH bun run --cwd packages/scenario-runner typecheck
```

Publish/package checks for changed publishable packages:

```sh
PATH=/Users/shawwalters/.bun/bin:$PATH bun run --cwd packages/core pack:dry-run
PATH=/Users/shawwalters/.bun/bin:$PATH bun run --cwd packages/agent pack:dry-run
PATH=/Users/shawwalters/.bun/bin:$PATH bun run --cwd packages/app-core pack:dry-run
PATH=/Users/shawwalters/.bun/bin:$PATH bun run --cwd packages/shared pack:dry-run
PATH=/Users/shawwalters/.bun/bin:$PATH bun run --cwd packages/ui pack:dry-run
```

## Signoff Criteria

- `fix-deps:check` passes with zero issues.
- No runtime relative imports cross package roots except an explicit allowlist.
- All runtime workspace imports are declared in the importer package manifest.
- Test-only helper imports are either declared as dev dependencies or moved to a shared test-support package.
- Duplicate package names are removed or made invisible to workspace/package scanners.
- Cloud workspace ownership is documented and validated with cloud-specific commands.
- Published package contracts are verified through build plus pack dry-run for every package whose exports/files/main/types changed.
