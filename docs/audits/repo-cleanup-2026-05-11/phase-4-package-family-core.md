# Phase 4 Core Package Family Audit

Date: 2026-05-11

Scope audited:

- `packages/core`
- `packages/shared`
- `packages/agent`
- `packages/app-core`
- `packages/ui`
- `packages/app`
- `packages/elizaos`
- `packages/vault`
- `packages/skills`
- `packages/scenario`
- `packages/cloud-routing`
- `packages/sdk`

Important scope note:

- `packages/scenario` does not exist. The repo has `packages/scenario-runner`
  and `packages/scenario-schema`, which should receive a separate scenario
  package audit.
- `packages/sdk` does not exist. The repo has `cloud/packages/sdk`, which is
  outside this assigned path scope and should be audited with the cloud package
  family.
- This report only writes findings. It does not delete, rename, or edit source.

Related reports:

- `docs/audits/repo-cleanup-2026-05-11/phase-3-generated-artifacts-and-binaries.md`
- `docs/audits/repo-cleanup-2026-05-11/phase-3-naming-shims-reexports.md`
- `docs/audits/repo-cleanup-2026-05-11/phase-3-backend-types-routes-duplication.md`
- `docs/audits/repo-cleanup-2026-05-11/phase-3-test-quality-and-speed.md`
- `docs/audits/repo-cleanup-2026-05-11/VALIDATION_STATUS.md`

## Executive Findings

1. The largest confirmed tracked artifact problem in this scope is
   `packages/agent/dist-mobile-ios*`. Git tracks 11 generated mobile bundle
   files, including `agent-bundle*.js`, `initdb.wasm`, `pglite.wasm`, and
   `pglite.data`. These should be deleted from git and rebuilt by
   `packages/agent/scripts/build-mobile-bundle.mjs`.

2. `packages/app-core/test/contracts/lib/openzeppelin-contracts` is a vendored
   dependency tree: 608 tracked files, about 11 MB, including upstream docs,
   audits, formal-verification reports, scripts, hardhat config, GitHub files,
   and Solidity sources. If tests only need a small fixture surface, replace it
   with a minimal local fixture or a package/download step.

3. `packages/shared/src/config` and `packages/ui/src/config` contain exact
   duplicate source files. Confirmed byte-identical duplicates:
   `allowed-hosts.ts`, `api-key-prefix-hints.ts`, `app-config.ts`,
   `boot-config-react.tsx`, `boot-config.ts`, `cloud-only.ts`,
   `plugin-ui-spec.ts`, and `ui-spec.ts`.

4. `packages/shared/src/utils/sql-compat.ts` and
   `packages/ui/src/utils/sql-compat.ts` are byte-identical. This is a
   high-confidence duplicate. UI should import or re-export the shared module
   instead of owning a second copy.

5. Several source files are compatibility bridges by name and behavior. Some
   are intentionally keeping old consumers alive, but they should be made
   explicit, dated, and queued for deletion behind validation:
   `packages/agent/src/config/plugin-auto-enable.ts`,
   `packages/app-core/src/ui-compat.ts`, `packages/app-core/src/browser.ts`,
   `packages/ui/src/api/agent-client-type-shim.ts`,
   `packages/ui/src/state/useOnboardingCompat.ts`, and the app-core
   `*-compat-routes.ts` files.

6. There are cross-package source reach-through imports that bypass package
   boundaries:
   `packages/app-core/src/services/tool-call-cache/index.ts` imports from
   `../../../../agent/src/runtime/tool-call-cache/index.ts`, and
   `packages/ui/src/types/index.ts` exports from
   `../../../shared/src/types/index`.

7. The UI package still contains legacy onboarding compatibility. Its own
   README states `flow.ts` helpers are effectively no-ops after the wizard was
   removed and are scheduled for follow-up removal.

8. The `packages/app` native build outputs are not tracked, but local ignored
   directories are huge: about 1.6 GB under `packages/app/android`, 1.7 GB under
   `packages/app/ios`, and 523 MB under `packages/app/electrobun`. These need
   durable ignore and clean-script coverage, not source control.

9. `packages/app-core` is carrying too many responsibilities in one package:
   API server, auth, local inference, mobile/native build tooling, packaging,
   benchmark server, Electrobun platform code, UI compatibility, test fixtures,
   and registry/runtime glue.

10. Root validation is not fully green yet per `VALIDATION_STATUS.md`:
    `lint`, `typecheck`, `build`, focused DFlash tests, madge, and diff-check
    passed; root `test` hangs in app-core; `knip` is blocked by an oxc native
    binding signature failure.

## Inventory Snapshot

Non-build file counts after excluding common build/cache directories:

| Package | Non-build files | TS/TSX | Markdown | JSON/JSONL |
| --- | ---: | ---: | ---: | ---: |
| `packages/core` | 700 | 681 | 7 | 5 |
| `packages/shared` | 202 | 188 | 1 | 9 |
| `packages/agent` | 1045 | 718 | 3 | 4 |
| `packages/app-core` | 3833 | 517 | 69 | 266 |
| `packages/ui` | 751 | 730 | 2 | 11 |
| `packages/app` | 1045 | 53 | 3 | 43 |
| `packages/elizaos` | 180 | 90 | 7 | 19 |
| `packages/vault` | 33 | 29 | 1 | 3 |
| `packages/skills` | 76 | 10 | 57 | 2 |
| `packages/cloud-routing` | 10 | 6 | 1 | 3 |

Tracked generated/binary candidates confirmed by git:

- `packages/agent/dist-mobile-ios/agent-bundle.js`
- `packages/agent/dist-mobile-ios/initdb.wasm`
- `packages/agent/dist-mobile-ios/pglite.data`
- `packages/agent/dist-mobile-ios/pglite.wasm`
- `packages/agent/dist-mobile-ios/plugins-manifest.json`
- `packages/agent/dist-mobile-ios-jsc/agent-bundle-ios.js`
- `packages/agent/dist-mobile-ios-jsc/initdb.wasm`
- `packages/agent/dist-mobile-ios-jsc/manifest.json`
- `packages/agent/dist-mobile-ios-jsc/pglite.data`
- `packages/agent/dist-mobile-ios-jsc/pglite.wasm`
- `packages/agent/dist-mobile-ios-jsc/plugins-manifest.json`
- `packages/app-core/platforms/android/gradle/wrapper/gradle-wrapper.jar`
- `packages/app-core/platforms/electrobun/src/libMacWindowEffects.dylib`

The Gradle wrapper jar and Electrobun dylib may be intentional vendored binary
inputs. They should not be removed blindly, but they need explicit ownership,
checksum, source, and rebuild documentation.

Generated JSON candidates found in scope:

- `packages/app-core/collision-report.json`
- `packages/app-core/scripts/generated/static-asset-manifest.json`
- `packages/shared/src/i18n/keywords/action-search.generated.keywords.json`
- `packages/elizaos/templates-manifest.json`
- `packages/agent/dist-mobile-ios*/manifest.json`
- `packages/agent/dist-mobile-ios*/plugins-manifest.json`

Keep or review:

- `packages/app-core/src/registry/entries/apps/training.json` appears to be
  registry source data, not a generated artifact by name alone.
- `packages/app-core/src/services/local-inference/manifest/eliza-1.manifest.v1.json`
  appears to be model/runtime metadata, not disposable benchmark output.

## Repo-Wide TODOs For This Package Family

### C1 - Delete tracked generated mobile bundles

Action:

- Remove git-tracked generated outputs under:
  - `packages/agent/dist-mobile-ios/`
  - `packages/agent/dist-mobile-ios-jsc/`
- Ensure `packages/agent/dist-mobile/`, `packages/agent/dist-mobile-ios/`, and
  `packages/agent/dist-mobile-ios-jsc/` are ignored consistently.
- Add or verify a clean command that removes all three directories.
- Validate mobile bundle generation from source using the existing package
  scripts instead of checked-in output.

Validation:

```bash
git ls-files packages/agent/dist-mobile packages/agent/dist-mobile-ios packages/agent/dist-mobile-ios-jsc
cd packages/agent && bun run build:mobile
cd packages/agent && bun run typecheck && bun run test
```

Expected final state:

- `git ls-files packages/agent/dist-mobile*` returns no generated bundle files.
- Mobile bundle scripts still produce runnable artifacts locally.

### C2 - Replace duplicated shared/UI config modules

Action:

- Pick `@elizaos/shared` as the owner for cross-environment contracts:
  `allowed-hosts`, `api-key-prefix-hints`, `app-config`, `boot-config`,
  `cloud-only`, `plugin-ui-spec`, and `ui-spec`.
- In `packages/ui/src/config`, replace exact duplicates with direct imports or
  narrow re-exports from `@elizaos/shared`.
- Keep UI-only files in UI: rendering hooks, branding React wrappers, and any
  browser-only store code that actually differs.
- Update `packages/ui/src/config/index.ts` to export the canonical modules.

Validation:

```bash
cmp -s packages/shared/src/config/app-config.ts packages/ui/src/config/app-config.ts; echo $?
cd packages/shared && bun run typecheck && bun run build
cd packages/ui && bun run typecheck && bun run build && bun run test
```

Expected final state:

- The `cmp` check should fail because the UI copy no longer exists or is a
  tiny re-export.
- Consumers can still import config types from `@elizaos/ui` if that public
  surface is required.

### C3 - Consolidate duplicated SQL compatibility helpers

Action:

- Delete `packages/ui/src/utils/sql-compat.ts`.
- Re-export from `@elizaos/shared` through `packages/ui/src/utils/index.ts`, or
  update UI call sites to import from `@elizaos/shared`.
- Keep only one implementation in `packages/shared/src/utils/sql-compat.ts`.

Validation:

```bash
rg -n "sql-compat" packages/ui/src packages/shared/src
cd packages/shared && bun run typecheck && bun run build
cd packages/ui && bun run typecheck && bun run test
```

Expected final state:

- One implementation file remains.
- UI has no behavioral diff because current files are byte-identical.

### C4 - Remove cross-package source reach-through imports

Action:

- Move `packages/agent/src/runtime/tool-call-cache` to an owning shared package,
  or expose it through a public package export in `@elizaos/agent`.
- Replace `packages/app-core/src/services/tool-call-cache/index.ts` imports from
  `../../../../agent/src/...` with that public export.
- Replace `packages/ui/src/types/index.ts` source reach-through with an export
  from `@elizaos/shared`.

Validation:

```bash
rg -n "from ['\"]\\.\\./\\.\\./\\.\\./|from ['\"]\\.\\./\\.\\./\\.\\./\\.\\./" packages/app-core/src packages/ui/src
cd packages/agent && bun run typecheck && bun run build
cd packages/app-core && bun run typecheck && bun run build
cd packages/ui && bun run typecheck && bun run build
```

Expected final state:

- No package reaches into another package's `src` tree.
- Public imports go through package exports only.

### C5 - Make compatibility bridges temporary and removable

Action:

- For every compat/shim/fallback bridge, classify it as:
  - required current public API,
  - required only for old bundled artifacts,
  - dead after all packages build from current source,
  - test-only.
- Add a deletion owner and validation gate in this audit folder before
  deleting.
- Rename surviving modules away from generic `compat` names when they are
  actually canonical behavior.

Primary files:

- `packages/agent/src/config/plugin-auto-enable.ts`
- `packages/agent/src/services/version-compat.ts`
- `packages/agent/src/api/compat-utils.ts`
- `packages/agent/src/api/music-player-route-fallback.ts`
- `packages/core/src/runtime/schema-compat.ts`
- `packages/core/src/utils/crypto-compat.ts`
- `packages/app-core/src/api/automations-compat-routes.ts`
- `packages/app-core/src/api/database-rows-compat-routes.ts`
- `packages/app-core/src/api/dev-compat-routes.ts`
- `packages/app-core/src/api/local-inference-compat-routes.ts`
- `packages/app-core/src/api/workbench-compat-routes.ts`
- `packages/app-core/src/ui-compat.ts`
- `packages/app-core/src/browser.ts`
- `packages/ui/src/api/agent-client-type-shim.ts`
- `packages/ui/src/state/useOnboardingCompat.ts`
- `packages/vault/test/vitest-assertion-shim.ts`

Validation:

```bash
rg -n "(compat|shim|fallback|legacy|deprecated)" packages/core packages/shared packages/agent packages/app-core packages/ui packages/app packages/elizaos packages/vault packages/skills packages/cloud-routing --glob '!dist/**'
bun run typecheck
bun run build
```

Expected final state:

- No compatibility bridge remains without a live consumer and a deletion plan.

### C6 - Remove vendored OpenZeppelin tree or shrink it to fixtures

Action:

- Determine which tests import or execute files under
  `packages/app-core/test/contracts/lib/openzeppelin-contracts`.
- Replace the full vendored upstream repo with:
  - a minimal Solidity fixture subset,
  - a package-manager dependency,
  - or an explicit setup/download script.
- Delete upstream docs/audits/reports/scripts if not required by tests.

Validation:

```bash
rg -n "openzeppelin-contracts" packages/app-core/test packages/app-core/src
git ls-files packages/app-core/test/contracts/lib/openzeppelin-contracts | wc -l
cd packages/app-core && bun run test -- test/contracts
```

Expected final state:

- The fixture surface is intentionally small.
- Upstream repository metadata, docs, and reports are not checked into this
  repo unless a test directly needs them.

### C7 - Normalize generated JSON and manifest ownership

Action:

- Decide whether these are source inputs or generated outputs:
  - `packages/app-core/collision-report.json`
  - `packages/app-core/scripts/generated/static-asset-manifest.json`
  - `packages/shared/src/i18n/keywords/action-search.generated.keywords.json`
  - `packages/elizaos/templates-manifest.json`
- If generated, add deterministic generation scripts and ignore rules.
- If source inputs, remove `generated` from names where possible and document
  the editing workflow.

Validation:

```bash
rg -n "collision-report|static-asset-manifest|action-search.generated|templates-manifest" packages scripts
bun run build
git diff --exit-code -- packages/app-core/collision-report.json packages/app-core/scripts/generated/static-asset-manifest.json packages/shared/src/i18n/keywords/action-search.generated.keywords.json packages/elizaos/templates-manifest.json
```

Expected final state:

- Generated files are either not tracked or reproducibly generated with no diff.

### C8 - Package-boundary dependency cleanup

Action:

- Review undeclared or optional internal package imports detected by scan:
  - `packages/agent/src/runtime/android-app-plugins.ts` imports app packages
    not declared in `packages/agent/package.json`.
  - `packages/agent/src/api/server-types.ts` references
    `@elizaos/plugin-telegram`, which is not declared in the package deps.
  - `packages/app-core/src/platform/native-plugin-entrypoints.ts` imports many
    capacitor packages not declared in `packages/app-core/package.json`.
- Decide for each import whether it is:
  - a hard runtime dependency,
  - optional dynamic plugin resolution,
  - type-only/test-only,
  - or stale.
- Declare hard dependencies, move optional lists to registries, or replace
  imports with data-driven package IDs.

Validation:

```bash
bun run knip
cd packages/agent && bun run typecheck && bun run build
cd packages/app-core && bun run typecheck && bun run build
```

Known blocker:

- `bun run knip` currently fails before analysis because the local
  `@oxc-resolver/binding-darwin-arm64` native binding is rejected by macOS code
  signing. Fix that environment issue before using knip output as a gate.

## Package-by-Package TODOs

## `packages/core`

Observations:

- Large public surface with wildcard exports in `src/index.node.ts`,
  `src/index.browser.ts`, and `src/index.edge.ts`.
- Browser entry contains explicit Node stubs and re-exports
  `runtime/schema-compat`.
- `src/runtime/schema-compat.ts` is real provider-normalization logic, not
  necessarily dead code, but the name encodes temporary compatibility.
- `src/utils/crypto-compat.ts` is cross-platform crypto, also likely canonical
  despite `compat` naming.
- Live tests under `packages/core/test/live` import `@elizaos/agent` and
  plugins. These are not core runtime dependencies and should not leak into
  package build assumptions.
- `packages/core/src/__tests__/read-attachment-action.live.test.ts` imports
  `../../../app-core/test/helpers/live-agent-test`, which reaches into another
  package test helper.
- Markdown candidates:
  `CHANGELOG.md`, `ROADMAP.md`, and `docs/*.md` should be reviewed. Keep
  `README.md`. Move durable architecture docs to the docs site if they are not
  package-local developer docs.

TODOs:

- Replace broad wildcard public exports with an explicit reviewed export map,
  especially for browser and edge entries.
- Rename `runtime/schema-compat.ts` to a canonical provider-specific name such
  as `provider-schema-normalization.ts` if behavior is current.
- Rename `utils/crypto-compat.ts` to `crypto-portable.ts` or similar if this is
  the canonical crypto abstraction.
- Move core live-test helpers out of app-core reach-through, or publish shared
  test helpers through `@elizaos/core/testing` or a test-support package.
- Keep generated validation keyword data deterministic and either source-owned
  or build-generated, not mixed.

Validation:

```bash
cd packages/core && bun run lint:check && bun run typecheck && bun run build && bun run test
cd packages/core && bun run pack:dry-run
```

## `packages/shared`

Observations:

- Correct place for cross-environment contracts, but it currently duplicates
  config modules into UI.
- Exact duplicate with UI:
  - `src/config/allowed-hosts.ts`
  - `src/config/api-key-prefix-hints.ts`
  - `src/config/app-config.ts`
  - `src/config/boot-config-react.tsx`
  - `src/config/boot-config.ts`
  - `src/config/cloud-only.ts`
  - `src/config/plugin-ui-spec.ts`
  - `src/config/ui-spec.ts`
  - `src/utils/sql-compat.ts`
- `src/i18n/keywords/action-search.generated.keywords.json` is tracked and
  named generated.
- Ignored generated files currently appear under `packages/shared/src`, such as
  `src/i18n/generated/` and `src/types/index.d.ts`.

TODOs:

- Make shared the owner for config and SQL compatibility helpers.
- Remove exact duplicate config and SQL files from UI after maintaining public
  UI exports as re-exports where needed.
- Decide if generated i18n keyword JSON is source input. If not, generate it
  during build and ignore it.
- Ensure ignored generated `.d.ts` and `.map` files under `src` are cleaned by
  `bun run clean`.

Validation:

```bash
cd packages/shared && bun run lint && bun run typecheck && bun run build && bun run test
cd packages/shared && bun run pack:dry-run
```

## `packages/agent`

Observations:

- Package exports source directly for `"."` and some subpaths. Main points to
  `src/index.ts`, while files only publish `dist`. This creates a split between
  workspace use and package use.
- Tracked generated mobile bundle outputs exist under `dist-mobile-ios` and
  `dist-mobile-ios-jsc`.
- Ignored generated `.d.ts` and `.d.ts.map` files exist under `src`.
- `src/config/plugin-auto-enable.ts` is an explicit compat bridge for old
  consumers importing `@elizaos/agent/config/plugin-auto-enable`.
- `src/services/version-compat.ts`, `src/api/compat-utils.ts`,
  `src/api/music-player-route-fallback.ts`, and `src/runtime/pglite-error-compat.ts`
  need classification before deletion.
- `src/services/index.ts` uses wildcard exports and pulls in
  `@elizaos/plugin-coding-tools`.
- `src/runtime/android-app-plugins.ts` imports app packages not declared in
  `package.json`, likely as optional platform plugins.
- `test` imports app-core test helpers via relative package reach-through.

TODOs:

- Delete tracked `dist-mobile-ios*` outputs from git and rely on build scripts.
- Align package exports so workspace and published consumers hit equivalent
  entrypoints. Avoid source exports in published package metadata unless that
  is an intentional Bun-only contract.
- Replace optional app/plugin direct imports with registry data or dynamic
  plugin resolution where possible.
- Promote `plugin-auto-enable` to shared-only imports once old packaged
  `eliza-dist` bundles are gone.
- Review `music-player-route-fallback`: if UI should not poll absent plugins,
  fix UI polling and delete the server fallback.
- Move cross-package test helpers into a shared testing package or package
  subpath.

Validation:

```bash
cd packages/agent && bun run lint:check && bun run typecheck && bun run build && bun run test
cd packages/agent && bun run build:mobile
cd packages/agent && bun run pack:dry-run
git ls-files packages/agent/dist-mobile packages/agent/dist-mobile-ios packages/agent/dist-mobile-ios-jsc
```

## `packages/app-core`

Observations:

- This package has the broadest responsibility in the scoped set: runtime API,
  auth, local inference, registry, security, desktop/native platform, mobile
  build tooling, packaging, benchmarks, tests, and UI bridge code.
- `src/index.ts` re-exports `./ui-compat`, which re-exports `@elizaos/ui`.
  That keeps old app-core UI consumers working but weakens the boundary between
  runtime/server and UI packages.
- `src/browser.ts` exports `@elizaos/ui`, exports from `../dist/index.js`, and
  defines no-op stubs for removed desktop runtime symbols. This is a high-risk
  bridge and should be deleted once consumers move to canonical UI imports.
- `src/services/tool-call-cache/index.ts` imports source from
  `packages/agent/src/runtime/tool-call-cache`.
- Multiple API files are named `*-compat-routes.ts`; some may now be canonical
  routes and should be renamed, while old aliases should be deleted.
- `src/benchmark` contains active benchmark server/test code plus markdown gap
  notes. This should be either a separate package or under `test/benchmarks`.
- `test/contracts/lib/openzeppelin-contracts` is a large vendored repo.
- Local generated/ignored build outputs include `.tmp`, `action-benchmark-report`,
  `platforms/electrobun/build`, Android Gradle outputs, and platform assets.
- Current dirty source files in this package pre-existed this audit:
  `scripts/playwright-ui-live-stack.ts`,
  `scripts/playwright-ui-smoke-api-stub.mjs`,
  `src/services/local-inference/__stress__/cache-stress-helpers.ts`,
  `src/services/local-inference/dflash-cache-flow.test.ts`, and
  `src/services/local-inference/voice/turn-controller.test.ts`.

TODOs:

- Split app-core responsibilities into clearer packages or subpackages:
  runtime API, native packaging/build scripts, local inference, benchmarks, and
  UI compatibility.
- Remove `src/browser.ts` no-op exports after moving renderer consumers to
  `@elizaos/ui` or a real browser entrypoint.
- Move tool-call cache to an owner that app-core can import through a package
  export.
- Rename canonical route modules away from `compat`; delete actual aliases
  after route catalog validation.
- Move benchmark server code out of `src` if it is not package runtime.
- Replace vendored OpenZeppelin tree with minimal fixtures or an install step.
- Classify `collision-report.json` and `scripts/generated/static-asset-manifest.json`
  as generated or source-owned, then enforce generation.

Validation:

```bash
cd packages/app-core && bun run lint && bun run typecheck && bun run build
cd packages/app-core && bun run test:auth
cd packages/app-core && bun run test -- src/api src/services
cd packages/app-core && bun run pack:dry-run
```

Known validation risk:

- Root `bun run test` currently hangs in app-core according to the current
  validation report. Do not use a hanging root test as proof of cleanup quality
  until the app-core Vitest worker hang is isolated.

## `packages/ui`

Observations:

- UI contains exact duplicates of shared config modules and SQL compatibility.
- `src/types/index.ts` reaches directly into `../../../shared/src/types/index`.
- `src/api/agent-client-type-shim.ts` defines many duplicated API-facing types.
  Some aliases point to `@elizaos/core` and `@elizaos/shared`, but many types
  are locally duplicated.
- `src/state/useOnboardingCompat.ts` exists because old onboarding callbacks
  still expect legacy fields. `src/onboarding/README.md` says `flow.ts` helpers
  are effectively no-ops after wizard removal.
- `src/state/AppContext.tsx` is a large state coordinator with lint dependency
  suppressions and multiple derived concerns. Current local edits exist in
  `src/navigation/index.ts` and `src/state/useChatCallbacks.ts`.
- UI has many justified lint suppressions. The highest-priority cleanup is
  hook dependency suppressions in central state files, not test-only
  `@ts-expect-error` runtime guard probes.

TODOs:

- Replace duplicate config and SQL helper modules with shared imports.
- Replace `src/types/index.ts` source reach-through with a public
  `@elizaos/shared` export.
- Move API contract types out of `agent-client-type-shim.ts` into shared/core
  contracts, then re-export from UI for compatibility if needed.
- Delete legacy onboarding `flow.ts` and `useOnboardingCompat.ts` once
  `useOnboardingCallbacks.ts` and app consumers are migrated.
- Split `AppContext.tsx` by state domain: runtime connection, chat, onboarding,
  apps, settings, and platform. Keep provider composition explicit.
- Audit UI suppressions around `react-hooks/exhaustive-deps` and
  `useExhaustiveDependencies`; remove by stabilizing state ownership instead of
  widening dependency arrays blindly.

Validation:

```bash
cd packages/ui && bun run lint && bun run typecheck && bun run build && bun run test
rg -n "agent-client-type-shim|useOnboardingCompat|\\.\\./\\.\\./\\.\\./shared/src" packages/ui/src
```

## `packages/app`

Observations:

- Private Vite/Capacitor shell with many app and native plugin dependencies.
- Native/generated local outputs are ignored but huge:
  - `packages/app/android` about 1.6 GB locally
  - `packages/app/ios` about 1.7 GB locally
  - `packages/app/electrobun` about 523 MB locally
- `vite.config.ts` contains several stub/fallback paths for native modules and
  browser bundling. These may be legitimate platform adapters, but they should
  be consolidated and documented because they are currently spread across app
  and app-core.
- `packages/app/scripts/HANDOFF.md` is ignored/untracked and should either be
  deleted locally or moved into the audit folder if it contains useful
  transient notes.
- Current dirty files pre-existed this audit:
  `test/ui-smoke/all-pages-clicksafe.spec.ts` and
  `test/ui-smoke/apps-utility-interactions.spec.ts`.

TODOs:

- Keep native build output ignored and add a clear `clean:native` path that
  removes Android, iOS, Electrobun, Vite, and Playwright artifacts.
- Move native stub plugin logic shared with app-core into one package-owned
  utility or platform adapter.
- Verify `public` assets are source assets, not generated copies from app-core.
- Keep `packages/app` private. Do not add exports unless it becomes a package.

Validation:

```bash
cd packages/app && bun run lint && bun run typecheck && bun run build && bun run test
cd packages/app && bun run test:e2e
git status --ignored --short packages/app
```

## `packages/elizaos`

Observations:

- CLI package with `files` publishing `dist`, `templates`,
  `templates-manifest.json`, and `README.md`.
- `templates-manifest.json` is currently modified in the working tree and
  appears generated.
- Templates contain type stubs under
  `templates/project/apps/app/src/type-stubs/**`. These are useful only if
  template builds need them before dependencies install; otherwise they are
  duplicative API shims.
- Template package imports look undeclared from the parent package perspective,
  but they are likely meant to be dependencies of generated template projects,
  not the CLI package itself.
- Markdown under templates is part of scaffold output. Keep only what a new
  project user actually needs.

TODOs:

- Make `templates-manifest.json` deterministic and generated from templates.
- Validate whether `type-stubs/**` can be removed by improving template
  dependency setup. If not, generate them from package declarations.
- Reduce template markdown to `README.md` plus necessary scaffold instructions.
- Keep CLI package deps minimal; do not let template deps leak into CLI deps.

Validation:

```bash
cd packages/elizaos && bun run lint:check && bun run typecheck && bun run build && bun run test
cd packages/elizaos && bun run test:packaged
git diff --exit-code -- packages/elizaos/templates-manifest.json
```

## `packages/vault`

Observations:

- Small package with clear responsibility.
- Contains explicit legacy file-backed vault migration paths:
  `src/pglite-vault.ts`, `src/vault.ts`, `src/profiles.ts`, and tests.
- `src/vault.ts` re-exports ergonomic helpers from `store.ts`.
- `test/vitest-assertion-shim.ts` contains a biome ignore.
- Fallback behavior in master key and external credential resolution appears
  security-sensitive and should not be removed without migration tests.

TODOs:

- Add a versioned sunset plan for `legacyStorePath` and file-backed vault mode.
- Keep migration tests until the migration code is deleted.
- Replace `test/vitest-assertion-shim.ts` if Vitest typings can be updated or
  narrowed without a shim.
- Document master-key fallback order as a security contract, not incidental
  fallback behavior.

Validation:

```bash
cd packages/vault && bun run typecheck && bun run build && bun run test
cd packages/vault && bun run pack:dry-run
```

## `packages/skills`

Observations:

- Markdown is runtime content in this package. `skills/**/SKILL.md` and
  `skills/**/references/*.md` should not be treated as documentation slop by
  default because `package.json` publishes `skills/**/*`.
- `src/formatter.ts` has a naming fallback for command truncation. This is
  deterministic behavior, not cleanup target unless command naming changes.
- `skills/spotify-player/SKILL.md` includes a "commands (fallback)" section
  that should be reviewed for stale behavior.
- Package has minimal source code and a clear loader/formatter boundary.

TODOs:

- Keep `README.md` and skill markdown that is loaded at runtime.
- Validate every `skills/**/references/*.md` is referenced by its `SKILL.md`;
  delete orphan references.
- Consider moving large references to docs if they are not needed by runtime
  skill loading.
- Add a test that fails when published `skills/**/*` contains orphan files or
  missing referenced files.

Validation:

```bash
cd packages/skills && bun run lint:check && bun run build && bun run test
rg -n "references/" packages/skills/skills
```

## `packages/cloud-routing`

Observations:

- Small and cohesive package.
- README and tests mention "fallback", but the package contract is explicitly
  "no fallback noise"; the term is descriptive, not necessarily slop.
- `zod` is a peer dependency. Verify that published consumers always provide
  it, or move it to dependencies if runtime imports require it.

TODOs:

- Keep package small and separate from app-core local/cloud routing code.
- Ensure no duplicate routing policy types exist in app-core or UI.
- If cloud-routing types are reused elsewhere, import from this package rather
  than copying policy unions.

Validation:

```bash
cd packages/cloud-routing && bun run lint && bun run typecheck && bun run build && bun run test
cd packages/cloud-routing && bun run pack:dry-run
```

## Missing Assigned Paths

### `packages/scenario`

Finding:

- Missing path. Related packages are `packages/scenario-runner` and
  `packages/scenario-schema`.

TODO:

- Issue a separate package-family audit for:
  - `packages/scenario-runner`
  - `packages/scenario-schema`
  - scenario JSON/TS files under `test/scenarios` and plugin scenario dirs
  - scenario report output directories

### `packages/sdk`

Finding:

- Missing path. Related package is `cloud/packages/sdk`.

TODO:

- Audit `cloud/packages/sdk` with the cloud package family, not this core
  package family, because root scripts and plugin-elizacloud path aliases
  reference it from `cloud/`.

## Markdown Cleanup Candidates In Scope

Keep by default:

- Package `README.md` files.
- `packages/skills/skills/**/SKILL.md`, because they are runtime package
  content.
- Template `README.md` files that are emitted to new projects.

Review for deletion or docs-site migration:

- `packages/core/ROADMAP.md`
- `packages/core/docs/*.md`
- `packages/agent/CHANGELOG.md`
- `packages/app-core/REVIEW_2026-05-10.md`
- `packages/app-core/packaging/**/README.md`
- `packages/app-core/src/benchmark/*.md`
- `packages/app-core/test/benchmarks/E2E_CHECKLIST.md`
- `packages/app-core/test/browser-extension/README.md`
- `packages/elizaos/templates/*/SCAFFOLD.md`
- `packages/app/scripts/HANDOFF.md` if it becomes tracked

High-confidence wipe if replacing vendored contracts:

- `packages/app-core/test/contracts/lib/openzeppelin-contracts/**/*.md`
- `packages/app-core/test/contracts/lib/openzeppelin-contracts/**/*.adoc`
- `packages/app-core/test/contracts/lib/openzeppelin-contracts/fv/reports/*.pdf`

Validation:

```bash
rg --files packages/core packages/shared packages/agent packages/app-core packages/ui packages/app packages/elizaos packages/vault packages/skills packages/cloud-routing -g '*.md' -g '!dist/**' -g '!node_modules/**' -g '!.turbo/**'
```

## Suppression Cleanup Priorities

Do not delete all suppressions blindly. Prioritize suppressions in hot shared
code and central UI state:

- `packages/ui/src/state/AppContext.tsx`
- `packages/ui/src/state/useChatSend.ts`
- `packages/ui/src/state/useChatCallbacks.ts`
- `packages/ui/src/components/pages/ElizaCloudDashboard.tsx`
- `packages/ui/src/components/character/CharacterEditor*.tsx`
- `packages/app/vite/native-module-stub-plugin.ts`
- `packages/app-core/platforms/electrobun/src/*.ts`
- `packages/core/src/features/documents/url-ingest.ts`
- `packages/core/src/utils.ts`
- `packages/agent/src/runtime/web-search-tools.ts`

Lower priority:

- Test-only `@ts-expect-error` lines that intentionally exercise runtime
  guards.
- CSS or vendor-library suppressions with clear comments.

Validation:

```bash
rg -n "@ts-nocheck|@ts-ignore|@ts-expect-error|eslint-disable|biome-ignore" packages/core packages/shared packages/agent packages/app-core packages/ui packages/app packages/elizaos packages/vault packages/skills packages/cloud-routing --glob '!dist/**' --glob '!node_modules/**' --glob '!*test/contracts/lib/**'
```

## Signoff Checklist For Implementation Swarm

Before deleting source:

- Confirm no source edits from other agents are overwritten.
- Re-run package-specific typecheck before and after each package batch.
- For every deleted exported symbol, run `rg` across `packages`, `plugins`,
  `cloud`, `test`, `scripts`, and templates.
- For every generated file deletion, prove regeneration or prove it is unused.
- For every markdown deletion, prove it is not a runtime skill file, package
  README, generated docs-site input, or template output required by CLI tests.

Core validation batch:

```bash
bun run lint
bun run typecheck
bun run build
bun run test
bunx madge --circular --extensions ts,tsx --exclude '(dist|build|node_modules|.turbo|coverage|.claude|packages/inference/llama.cpp|packages/app-core/platforms/electrobun/build)' packages plugins test
bun run knip
git diff --check
```

Package publish validation:

```bash
cd packages/core && bun run pack:dry-run
cd packages/shared && bun run pack:dry-run
cd packages/agent && bun run pack:dry-run
cd packages/app-core && bun run pack:dry-run
cd packages/ui && bun run pack:dry-run
cd packages/elizaos && bun run test:packaged
cd packages/vault && bun run pack:dry-run
cd packages/cloud-routing && bun run pack:dry-run
```

Known blockers to resolve before final signoff:

- Root `bun run test` currently hangs in app-core.
- Root `bun run knip` currently fails before analysis due to the local oxc
  resolver native binding signature issue.
