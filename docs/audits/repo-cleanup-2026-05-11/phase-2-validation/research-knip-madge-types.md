# Phase 2 Validation - Knip, Madge, Barrel, Type Tooling

Date: 2026-05-11

Worker: Phase 2 research worker E

Scope: dependency/dead-code/consolidation tooling only. No source, config, or test files were edited. Raw command output was captured under `/tmp` so the repository only receives this report.

## Summary

- Current Knip analysis is blocked by an environment/native-binding failure in `oxc-resolver`, not by repository findings. Both the repo `knip` runner and a fresh `bunx knip@5.88.1` probe fail before analysis.
- Madge source-only cycle check completed and found 4 cycles across LifeOps scheduled-task wiring, UI branding, and two plugin route-registration barrels.
- Package barrel audit completed. The read-only audit exits 0, but the check gate exits 1 because the repo still has 26 package subpath references, 266 published subpath exports, and 617 literal re-export markers.
- Type audit completed in a temporary sandbox because the script writes fixed output paths under `scripts/`. It found 16,593 type definitions, 2,696 duplicate names, and 102,503 structural overlaps. The highest-confidence duplicate is a byte-identical 723-line copy between `packages/ui/src/types/index.ts` and `packages/shared/src/types/index.ts`.

## Commands Run

Environment probes:

| Command | Exit | Notes |
| --- | ---: | --- |
| `/Users/shawwalters/.bun/bin/bun --version` | 0 | `1.3.13` |
| `/Users/shawwalters/.bun/bin/bunx --version` | 0 | `1.3.13` |
| `git status --short` | 0 | Worktree already had many unrelated modified/untracked files before this worker. |

Primary tooling:

| Command | Exit | Output |
| --- | ---: | --- |
| `PATH="/Users/shawwalters/.bun/bin:$PATH" NO_COLOR=1 /Users/shawwalters/.bun/bin/bun run knip -- --no-exit-code` | 1 | `/tmp/eliza-phase2-knip-20260511115058.txt` |
| `PATH="/Users/shawwalters/.bun/bin:$PATH" NO_COLOR=1 /Users/shawwalters/.bun/bin/bunx knip@5.88.1 --version` | 1 | `/tmp/eliza-phase2-knip-bunx-probe-20260511115436.txt` |
| `PATH="/Users/shawwalters/.bun/bin:$PATH" NO_COLOR=1 /Users/shawwalters/.bun/bin/bunx madge --circular --extensions ts,tsx --exclude '(dist|build|node_modules|.turbo|coverage|.claude|packages/inference/llama.cpp|packages/app-core/platforms/electrobun/build)' packages plugins test` | 1 | `/tmp/eliza-phase2-madge-source-cycles-20260511115458.txt` |
| `PATH="/Users/shawwalters/.bun/bin:$PATH" NO_COLOR=1 /Users/shawwalters/.bun/bin/bun run audit:package-barrels` | 0 | `/tmp/eliza-phase2-package-barrels-20260511115715.txt` |
| `PATH="/Users/shawwalters/.bun/bin:$PATH" NO_COLOR=1 /Users/shawwalters/.bun/bin/bun run audit:package-barrels:check` | 1 | `/tmp/eliza-phase2-package-barrels-check-20260511115805.txt` |
| `PATH="/Users/shawwalters/.bun/bin:$PATH" NO_COLOR=1 /Users/shawwalters/.bun/bin/bun /tmp/eliza-phase2-type-audit-20260511115823/scripts/type-audit.mjs --json` | 0 | `/tmp/eliza-phase2-type-audit-20260511115823/scripts/type-audit-report.md` and `.json` |

Type audit setup command, intentionally outside the repo:

```bash
TYPE_ROOT="/tmp/eliza-phase2-type-audit-20260511115823"
mkdir -p "$TYPE_ROOT/scripts"
cp scripts/type-audit.mjs "$TYPE_ROOT/scripts/type-audit.mjs"
ln -s /Users/shawwalters/eliza-workspace/milady/eliza/packages "$TYPE_ROOT/packages"
ln -s /Users/shawwalters/eliza-workspace/milady/eliza/plugins "$TYPE_ROOT/plugins"
ln -s /Users/shawwalters/eliza-workspace/milady/eliza/node_modules "$TYPE_ROOT/node_modules"
/Users/shawwalters/.bun/bin/bun "$TYPE_ROOT/scripts/type-audit.mjs" --json
```

Reason: `scripts/type-audit.mjs` writes to `scripts/type-audit-report.md` and `scripts/type-audit-report.json` in its computed root. Running it in-place would violate this worker's constraint to only create/edit this report.

## Knip Findings

The requested command was feasible to invoke, but not feasible to analyze:

- Repo runner saw 198 workspace packages.
- Every package invocation failed before Knip could produce dependency/dead-code results.
- Repeated error:
  - `Error: Cannot find native binding.`
  - Native module: `oxc-resolver@11.19.1`
  - Binding path: `@oxc-resolver/binding-darwin-arm64/resolver.darwin-arm64.node`
  - macOS loader reason: `code signature ... not valid for use in process: mapping process and mapped file (non-platform) have different Team IDs`
- Fresh `bunx knip@5.88.1 --version` failed with the same `oxc-resolver` native binding error, so this is not only stale local `node_modules`.

Reference-only historical baseline:

- `reports/porting/2026-05-09-baseline/knip.txt` exists and records: 2,619 unused files, 259 unused dependencies, 136 unused devDependencies, 406 unlisted dependencies, 21 unresolved imports, 3,932 unused exports, and 75 configuration hints.
- Treat that file as stale and noisy. It marks many framework entrypoints such as Cloud route files and default route exports as unused, which likely indicates missing Knip workspace/framework configuration rather than deletion-ready code.

Next action:

1. Repair the `oxc-resolver` native binding issue on this machine or rerun Knip on CI/Linux.
2. Add or tune Knip workspace configs before acting on unused files, especially for Next/Hono route conventions, generated specs, plugin entrypoints, native plugin packages, and side-effect registration modules.
3. Rerun `bun run knip -- --no-exit-code` and only promote package-scoped findings after owner review.

## Madge Findings

Command processed 7,715 files in 2m 7.5s with 144 warnings and found 4 circular dependencies:

| Cycle | Likely owner | Finding | Next action |
| --- | --- | --- | --- |
| `plugins/app-lifeops/src/lifeops/scheduled-task/service.ts > plugins/app-lifeops/src/lifeops/scheduled-task/runtime-wiring.ts` | `@elizaos/app-lifeops` | `service.ts` imports `createRuntimeScheduledTaskRunner` from `runtime-wiring.ts`, while `runtime-wiring.ts` re-exports `getScheduledTaskRunner` and `ScheduledTaskRunnerService` from `service.ts`. | Move the service-aware re-export out of `runtime-wiring.ts` into a neutral barrel, or split runner factory types so the service can depend one-way on runtime wiring. Preserve the single `ScheduledTask` primitive. |
| `packages/ui/src/config/branding.ts > packages/ui/src/config/branding-react.tsx` | `packages/ui` | `branding.ts` imports/exports React-bound `BrandingContext` and `useBranding`, while `branding-react.tsx` imports `DEFAULT_BRANDING` from `branding.ts`. This defeats the intended non-React split noted in comments. | Keep `branding.ts` node-safe. Either stop re-exporting React symbols from it or move shared defaults/types to a third file such as `branding-base.ts`. |
| `plugins/plugin-computeruse/src/index.ts > plugins/plugin-computeruse/src/register-routes.ts` | `@elizaos/plugin-computeruse` | `index.ts` exports `*` from `register-routes.ts`; `register-routes.ts` has a side-effect loader that dynamically imports `./index.js`. | Do not expose the side-effect registration module through the runtime public barrel. Make registration an explicit entrypoint or have the loader import a plugin-only module. |
| `plugins/plugin-github/src/index.ts > plugins/plugin-github/src/register-routes.ts` | `@elizaos/plugin-github` | Same side-effect registration pattern as computeruse. | Same remediation: separate side-effect route registration from public package exports. |

## Package Barrel Audit

Read-only audit result:

- Workspace packages: 214
- Source files scanned: 10,614
- Workspace package subpath references: 26
- Published package subpath exports: 266
- Literal re-export markers: 617

`audit:package-barrels:check` exits 1, so this is currently a failing cleanup gate.

Top subpath reference owners:

| Package | Count | Examples | Likely owner |
| --- | ---: | --- | --- |
| `@elizaos/ui` | 18 | `@elizaos/ui/api/client-types-cloud`, `@elizaos/ui/events`, `@elizaos/ui/onboarding-config`, `@elizaos/ui/config/app-config`, `@elizaos/ui/styles`, `@elizaos/ui/navigation` | UI/platform owners plus importing app owners |
| `@elizaos/agent` | 3 | `@elizaos/agent/config/plugin-auto-enable`, `@elizaos/agent/services/permissions/register-probers`, `@elizaos/agent/services/permissions/probers/index` | Agent API/runtime owners |
| `@elizaos/app-core` | 2 | local inference catalog/downloader in `scripts/verify-phone-download.mjs` | App-core/local inference owners |
| `@elizaos/app-lifeops` | 1 | `@elizaos/app-lifeops/seed-routine-migrator` | LifeOps |
| `@elizaos/core` | 1 | `@elizaos/core/testing` | Core/testing |
| `@elizaos/shared` | 1 | `@elizaos/shared/dev-settings-figlet-heading` | Shared/dev tooling |

Published subpath export hotspots:

- `@elizaos/ui`: 8
- `@elizaos/core`: 7
- `@elizaos/shared`: 7
- `@elizaos/agent`: 6
- `@elizaos/plugin-edge-tts`: 4
- `@elizaos/plugin-sql`: 4

Next action:

1. Decide which subpaths are approved public API versus migration debt.
2. For internal cross-package imports, move required symbols into root package barrels or documented conditional entrypoints.
3. Avoid deleting wildcard or browser/node subpath exports until downstream import inventory and package API checks pass.

## Type Audit Findings

Sandboxed type audit result:

- Files scanned: 6,341 TypeScript files
- Type definitions: 16,593
- Interfaces: 10,228
- Type aliases: 6,276
- Enums: 89
- Exported definitions: 11,960
- Unique names: 12,688
- Names with duplicates: 2,696
- Structural overlaps: 102,503 total
  - Identical: 7,391
  - Subset/superset: 31,073
  - Partial: 64,039

High-confidence consolidation candidates:

| Candidate | Evidence | Likely owner | Next action |
| --- | --- | --- | --- |
| `packages/ui/src/types/index.ts` and `packages/shared/src/types/index.ts` | `cmp` exit 0; both are 723 lines and byte-identical. Type audit reports identical structures for many exported symbols such as `ExistingElizaInstallInfo`, channel status types, connector status types, config UI types, and gateway types. | `packages/shared` and `packages/ui` | Pick canonical owner, likely `@elizaos/shared`; make UI re-export or import from shared. Validate app and package build boundaries before deleting the copy. |
| Generated `ActionDoc` and `ProviderDoc` | Each has 26 definitions across core generated action docs and plugin generated specs. | Core action-spec/codegen owners | Move the generated spec shape to one shared/generated contract or update generator templates to import a canonical type. Do not hand-edit generated files. |
| `JsonValue`, `JsonObject`, `JsonPrimitive` | `JsonValue` has 22 duplicate names; `JsonObject` 14; `JsonPrimitive` 11. Copies exist in core primitives, feature types, plugins, examples, and native gateway definitions. | Core/shared contract owners | Standardize on `packages/core/src/types/primitives.ts` or a shared contract package and migrate plugin-local copies only where package boundaries allow. |
| `CredentialProviderResult` | 15 definitions across workflow credential providers and plugin workflow types. | Workflow/plugin credential owners | Promote a canonical credential-provider result type and make provider implementations import it. |
| `ExtendedMessageConnectorRegistration` and `AdditiveMessageConnectorHooks` | 12 and 8 duplicate definitions across messaging connector plugins. | Connector/messaging plugin owners | Move additive connector registration hooks to a shared connector contract. |
| `TradePermissionMode` | 10 same-name definitions across UI, agent, core, shared, steward, and wallet. Important drift: some include `"disabled"` and others do not. | Wallet/trade-safety contract owners | Do not blindly re-export by name. First decide whether `"disabled"` is a supported mode in all planes, then consolidate. |
| `ElizaClient` | 16 definitions/augmentations across UI API modules and app plugins. | UI client/API owners | Keep as augmentation surface only if intentional. Otherwise split domain clients and avoid broad ambient interface growth. |

## Top Actionable Candidates

| Priority | Candidate | Type | Owner | Action |
| ---: | --- | --- | --- | --- |
| 1 | `oxc-resolver` native binding blocks Knip | Tooling | Repo tooling/dependency owners | Fix or rerun in CI before using Knip as a deletion signal. |
| 2 | `packages/ui/src/types/index.ts` duplicates `packages/shared/src/types/index.ts` exactly | Duplicate/type | Shared/UI | Convert one side to a re-export after build-boundary review. |
| 3 | LifeOps scheduled-task service/runtime-wiring cycle | Cycle | LifeOps | Remove service re-export from runtime-wiring or split neutral factory/types. |
| 4 | UI branding React cycle | Cycle | UI | Keep React context out of node-safe branding module. |
| 5 | Plugin `register-routes` side-effect cycles | Cycle/barrel | Computeruse/GitHub plugin owners | Do not re-export side-effect registration from public `index.ts`. |
| 6 | `@elizaos/ui` subpath imports | Barrel/API | UI plus app owners | Move stable symbols to root or approved conditional exports; migrate imports. |
| 7 | Public subpath export sprawl in UI/core/shared/agent | Barrel/API | Package owners | Define public API allowlist, then make `audit:package-barrels:check` block regressions. |
| 8 | Generated spec type duplication | Generated/type | Core/spec generator owners | Fix generator/template source, not generated outputs. |
| 9 | JSON primitive type copies | Type | Core/shared/plugin owners | Canonicalize primitive JSON aliases with package-boundary-safe imports. |
| 10 | Historical Knip unlisted dependencies in `cloud/**` | Dependency | Cloud package owners | After Knip works, add cloud workspace config and decide whether deps belong in `cloud/package.json`, subpackage manifests, or root. |

## Risks And Guardrails

- Do not delete files from Knip's historical unused list until current Knip runs successfully with framework-aware config. The May 9 baseline is useful for direction but too noisy for implementation.
- Do not collapse LifeOps or health contracts in a way that violates the repository charter: LifeOps owns the single `ScheduledTask` runner architecture, and health must contribute through registries without importing LifeOps internals.
- Do not remove route stubs or browser/no-op stubs solely because they look unused. Prior wave reports note that some are mounted compatibility behavior or static bundle shims.
- Treat generated files as generator outputs. Consolidate their source templates or shared contracts instead of hand-editing repeated generated definitions.

## Recommended Next Commands

After repairing the Knip native-binding issue:

```bash
/Users/shawwalters/.bun/bin/bun run knip -- --no-exit-code
/Users/shawwalters/.bun/bin/bun run audit:package-barrels:check
/Users/shawwalters/.bun/bin/bunx madge --circular --extensions ts,tsx --exclude '(dist|build|node_modules|.turbo|coverage|.claude|packages/inference/llama.cpp|packages/app-core/platforms/electrobun/build)' packages plugins test
```

For type consolidation validation, keep the type-audit script out of the repo or add an explicit output path option before making it part of normal validation.
