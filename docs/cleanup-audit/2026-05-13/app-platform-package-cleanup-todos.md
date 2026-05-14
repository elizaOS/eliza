# App/Platform Package Cleanup TODOs

Date: 2026-05-13

Scope:

- `packages/app`
- `packages/app-core`
- `packages/app-core/platforms/electrobun`
- Native platform packages: `packages/electrobun-carrots`, `packages/bun-ios-runtime`, `packages/ios-native-deps`, `packages/os`
- App-owned native plugins referenced by the app/platform boundary under `packages/native-plugins`

Rules for implementation:

- Do not delete first. Add checks, exports, manifests, and migration paths before pruning.
- Treat `packages/app` as the integration shell and app config owner.
- Treat `packages/app-core` as runtime/server/platform-build tooling until explicit subpackages are created.
- Treat native plugin packages as the owners of their Capacitor API and platform-specific native code.
- Every TODO below has a validation command. If the command is too broad for an intermediate PR, run the narrower package command plus the dependency TODO's validation.

## Order Overview

1. Add package-boundary checks that do not change runtime behavior.
2. Define explicit public entrypoints for app-core and Electrobun.
3. Consolidate native plugin inventory and registration.
4. Move duplicated bridge contracts to owning packages.
5. Reduce browser/server stubs after entrypoint cleanup.
6. Tighten publish/package payloads.
7. Consolidate iOS native runtime/dependency ownership.
8. Document and protect generated/local artifact paths.

## Phase 0 - Guardrails Before Refactors

### TODO 0.1 - Add an app/platform package exports smoke test

Paths:

- Add test/script under `packages/app-core/scripts/`
- Reference package manifests:
  - `packages/app-core/package.json`
  - `packages/app-core/platforms/electrobun/package.json`
  - `packages/ui/package.json`
  - `packages/electrobun-carrots/package.json`
  - `packages/bun-ios-runtime/package.json`
  - `packages/ios-native-deps/package.json`

Rationale:

The current source tree uses TS path aliases and copied `dist` files that can hide invalid package exports. A smoke test should install or import package entrypoints through their `exports` maps only.

Risk level:

- Low. Test-only, no runtime behavior change.

Validation command:

```bash
bun run --filter @elizaos/app-core test -- scripts/package-exports-smoke.test.ts
```

Dependencies/order:

- First TODO. Use this before changing package exports.

Implementation notes:

- Test supported imports only, not every physical file.
- Include negative assertions for known-invalid deep imports such as `@elizaos/app-core/platforms/electrobun/native/carrots` unless intentionally exported later.

### TODO 0.2 - Add a native plugin inventory drift check

Paths:

- `packages/app/scripts/capacitor-plugin-names.mjs`
- `packages/app-core/src/platform/native-plugin-entrypoints.ts`
- `packages/app/package.json`
- `packages/app-core/package.json`
- `packages/native-plugins/*/package.json`

Rationale:

`packages/app/scripts/capacitor-plugin-names.mjs` dynamically discovers native plugin packages, while `native-plugin-entrypoints.ts` manually imports a subset. A check should catch missing or intentionally excluded plugins before mobile boot breaks.

Risk level:

- Low. Test-only.

Validation command:

```bash
bun run --filter @elizaos/app-core test -- scripts/native-plugin-inventory.test.ts
```

Dependencies/order:

- Before TODO 3.1 and TODO 3.2.

Implementation notes:

- Create an explicit allowlist with reason strings for excluded packages.
- Check package names, dependency declarations, and entrypoint imports separately.

### TODO 0.3 - Add app-core package tarball budget/report check

Paths:

- `packages/app-core/package.json`
- `packages/app-core/scripts/`
- `packages/app-core/dist`

Rationale:

`packages/app-core` copies scripts, platforms, packaging, patches, and test helpers into `dist`. A report should make package payload size and suspicious file patterns visible before pruning.

Risk level:

- Low. Reporting only.

Validation command:

```bash
bun run --filter @elizaos/app-core build:dist && bun run --filter @elizaos/app-core pack:dry-run
```

Dependencies/order:

- Before TODO 6.1 and TODO 6.2.

Implementation notes:

- Flag `*.test.*`, `__tests__`, large binaries, platform `Pods`, `.xcframework`, `.wasm`, `.map`, and generated JSON.
- Do not fail CI on first PR; start as an artifact/report.

## Phase 1 - App-Core EntryPoint Split

### TODO 1.1 - Create explicit app-core runtime/server entrypoint

Paths:

- `packages/app-core/src/index.ts`
- Add `packages/app-core/src/node.ts` or `packages/app-core/src/runtime-node.ts`
- `packages/app-core/package.json`
- `packages/app-core/tsconfig.build.json`

Rationale:

The root app-core barrel mixes API server, runtime boot, security, services, registry, UI compatibility, and plugin re-exports. A server/runtime entrypoint makes Node ownership explicit without breaking existing root imports immediately.

Risk level:

- Medium. Public API and declaration output changes.

Validation command:

```bash
bun run --filter @elizaos/app-core typecheck && bun run --filter @elizaos/app-core build:dist && bun run --filter @elizaos/app-core pack:dry-run
```

Dependencies/order:

- After TODO 0.1.
- Before TODO 1.2, TODO 2.1, and TODO 5.1.

Implementation notes:

- Keep `.` exporting the existing compatibility surface during the first PR.
- Add `./node` or `./runtime-node` to `exports`.
- Document which server/runtime modules belong there.

### TODO 1.2 - Create explicit app-core browser/contracts entrypoint

Paths:

- `packages/app-core/src/browser.ts`
- Add `packages/app-core/src/contracts.ts` or `packages/app-core/src/browser-contracts.ts`
- `packages/app-core/package.json`
- `packages/app/src/main.tsx`
- `packages/app/vite.config.ts`

Rationale:

Renderer code should not need to traverse server/runtime barrels. Browser-safe contracts and UI handoffs need an explicit import target.

Risk level:

- High. Browser bundling can regress if a server import leaks.

Validation command:

```bash
bun run --filter @elizaos/app build:web && bun run --filter @elizaos/app typecheck
```

Dependencies/order:

- After TODO 1.1.
- Before reducing stubs in TODO 5.1.

Implementation notes:

- Move renderer imports away from bare `@elizaos/app-core` where feasible.
- Keep compatibility re-exports but mark them as deprecated in comments/docs.
- Avoid importing `@elizaos/ui` back through app-core if direct UI imports are possible.

### TODO 1.3 - Add an import-boundary rule for renderer code

Paths:

- `packages/app/knip.json`
- `packages/app/vite.config.ts`
- Optional new script under `packages/app/scripts/`

Rationale:

After browser-safe entrypoints exist, prevent new renderer imports from pulling bare app-core server/runtime modules back into the client graph.

Risk level:

- Low to medium. May initially surface existing violations.

Validation command:

```bash
bun run --filter @elizaos/app lint
```

Dependencies/order:

- After TODO 1.2.

Implementation notes:

- Start as warn/report if too many existing imports remain.
- Allow imports from the explicit browser/contracts entrypoint.

## Phase 2 - Electrobun Package Boundary

### TODO 2.1 - Give `@elizaos/electrobun` real exports

Paths:

- `packages/app-core/platforms/electrobun/package.json`
- `packages/app-core/platforms/electrobun/src/index.ts`
- `packages/app-core/platforms/electrobun/src/rpc-schema.ts`
- `packages/app-core/platforms/electrobun/src/native/carrots.ts`

Rationale:

The Electrobun package has package metadata but no `main`, `types`, or `exports`. Consumers and examples should not depend on app-core physical deep paths.

Risk level:

- Medium. Package consumers may need import path updates.

Validation command:

```bash
bun run --filter @elizaos/electrobun typecheck && bun run --filter @elizaos/electrobun test
```

Dependencies/order:

- After TODO 0.1.
- Before TODO 2.2.

Implementation notes:

- Add exports for supported APIs only, for example `.`, `./rpc-schema`, and possibly `./native/carrots` if that manager is intentionally public.
- Avoid exporting all native managers by wildcard.

### TODO 2.2 - Replace Electrobun deep-import examples with package exports

Paths:

- `packages/electrobun-carrots/examples/hello-carrot/README.md`
- `packages/electrobun-carrots/examples/carrot-clock/README.md`
- Any docs referencing `@elizaos/app-core/platforms/electrobun/*`

Rationale:

Examples currently demonstrate imports that are not valid through app-core's package export map. Docs should enforce the boundary.

Risk level:

- Low. Documentation/import guidance.

Validation command:

```bash
rg "@elizaos/app-core/platforms/electrobun" packages docs plugins
```

Dependencies/order:

- After TODO 2.1.

Implementation notes:

- If a deep path remains, add an explicit rationale and matching package export.

### TODO 2.3 - Decide whether Electrobun build tooling remains under app-core

Paths:

- `packages/app-core/platforms/electrobun/`
- `packages/app-core/scripts/build-electrobun-preload.mjs`
- `packages/app-core/package.json`
- `packages/app-core/platforms/electrobun/package.json`

Rationale:

The current physical layout makes app-core own Electrobun templates and scripts, while package naming suggests a dedicated platform package. This should be an explicit ownership decision.

Risk level:

- Medium. Moving scripts can break desktop dev/build commands.

Validation command:

```bash
bun run --filter @elizaos/electrobun typecheck && bun run --filter @elizaos/electrobun test && bun run --filter @elizaos/electrobun build
```

Dependencies/order:

- After TODO 2.1.
- Before any directory moves.

Implementation notes:

- A non-moving first step is to document ownership in package READMEs and exports.
- If moving later, preserve app-core script wrappers for one release.

## Phase 3 - Native Plugin Inventory and Registration

### TODO 3.1 - Generate native plugin side-effect entrypoint from inventory

Paths:

- `packages/app-core/src/platform/native-plugin-entrypoints.ts`
- `packages/app/scripts/capacitor-plugin-names.mjs`
- Add generated manifest/script under `packages/app-core/scripts/` or `packages/app/scripts/`
- `packages/native-plugins/*/package.json`

Rationale:

Native plugin registration is currently hand-maintained. Generating it from package metadata or app config reduces drift.

Risk level:

- High for mobile boot if generated list is wrong.

Validation command:

```bash
bun run --filter @elizaos/app build:ios:local:sim && bun run --filter @elizaos/app test:sim:local-chat:ios
```

Dependencies/order:

- After TODO 0.2.
- Before TODO 3.2.

Implementation notes:

- Keep generated file checked in only if the repo already expects checked-in generated source.
- Include an allowlist for intentionally app-only or platform-only native plugins.
- Preserve deterministic ordering.

### TODO 3.2 - Align app/app-core native plugin dependency declarations

Paths:

- `packages/app/package.json`
- `packages/app-core/package.json`
- `packages/native-plugins/*/package.json`
- `packages/app/app.config.ts`

Rationale:

The app declares a wide set of Capacitor plugins. App-core declares many as optional dependencies, but the lists do not fully match registration. Dependency ownership should follow who imports/registers/uses the plugin.

Risk level:

- Medium. Package manager and mobile sync behavior can change.

Validation command:

```bash
bun install --frozen-lockfile && bun run --filter @elizaos/app typecheck && bun run --filter @elizaos/app cap:sync
```

Dependencies/order:

- After TODO 3.1.

Implementation notes:

- Do not remove dependencies until the inventory check proves the intended owner.
- Keep app-owned plugins in `packages/app` if app config decides whether they ship.
- Keep runtime-required optional native plugin references in app-core only when app-core imports them.

### TODO 3.3 - Move app-owned native plugin policy into app config

Paths:

- `packages/app/app.config.ts`
- `packages/app/package.json`
- `packages/app/vite.config.ts`
- `packages/app-core/scripts/run-mobile-build.mjs`

Rationale:

`packages/app` acts as integration shell. Native plugin inclusion, app plugin defaults, and platform policy should be derivable from app config instead of spread across package.json, Vite aliases, and build scripts.

Risk level:

- Medium. Build scripts and Vite config must read the same shape.

Validation command:

```bash
bun run --filter @elizaos/app build:web && bun run --filter @elizaos/app cap:sync
```

Dependencies/order:

- After TODO 3.2.

Implementation notes:

- Start with a read-only generated report comparing config vs package dependencies.
- Only later drive package changes from config.

## Phase 4 - Contract and Type Consolidation

### TODO 4.1 - Move Carrot RPC/status contract types into `@elizaos/electrobun-carrots`

Paths:

- `packages/electrobun-carrots/src/types.ts`
- `packages/electrobun-carrots/src/index.ts`
- `packages/app-core/platforms/electrobun/src/native/carrots.ts`
- `packages/app-core/platforms/electrobun/src/rpc-schema.ts`
- `packages/ui/src/bridge/electrobun-rpc.ts`
- `packages/ui/src/components/settings/CarrotManagerSection.tsx`

Rationale:

Carrot domain types are repeated in the native manager, RPC schema, and UI bridge. The carrots package should own RPC-safe status, log, install result, and snapshot shapes.

Risk level:

- Medium. Type-only changes can still reveal runtime shape drift.

Validation command:

```bash
bun run --filter @elizaos/electrobun-carrots typecheck && bun run --filter @elizaos/electrobun typecheck && bun run --filter @elizaos/ui typecheck
```

Dependencies/order:

- After TODO 2.1.

Implementation notes:

- Keep wire names stable.
- Prefer type aliases from the owning package rather than UI-prefixed duplicate interfaces.

### TODO 4.2 - Generate or derive UI Electrobun bridge types from RPC schema

Paths:

- `packages/app-core/platforms/electrobun/src/rpc-schema.ts`
- `packages/ui/src/bridge/electrobun-rpc.ts`
- `packages/app-core/platforms/electrobun/src/rpc-handlers.ts`

Rationale:

Renderer bridge types are currently manually maintained. They should be derived from `ElizaDesktopRPCSchema` or a shared contracts package to avoid drift.

Risk level:

- High. Bridge type changes affect desktop UI calls.

Validation command:

```bash
bun run --filter @elizaos/electrobun test && bun run --filter @elizaos/ui test -- src/bridge/electrobun-runtime.test.ts
```

Dependencies/order:

- After TODO 4.1.

Implementation notes:

- Start with type-only imports if runtime dependency direction is a concern.
- Do not make UI import Electrobun runtime implementation code.

### TODO 4.3 - Move app-core/UI shared API contracts out of app-core runtime

Paths:

- `packages/ui/src/api/client-types*.ts`
- `packages/app-core/src/api/*`
- `packages/shared/src/` or a new app-core contracts entrypoint
- `packages/app-core/src/api/automation-node-contributors.ts`

Rationale:

UI and app-core share API payload contracts, but some types flow through runtime modules. Contracts should be independent of server boot and React components.

Risk level:

- High. Many imports and declarations may change.

Validation command:

```bash
bun run --filter @elizaos/ui typecheck && bun run --filter @elizaos/app-core typecheck && bun run --filter @elizaos/app typecheck
```

Dependencies/order:

- After TODO 1.1 and TODO 1.2.

Implementation notes:

- Move one domain at a time, starting with low-dependency types.
- Keep re-exports for compatibility during migration.

## Phase 5 - Browser Stub Reduction

### TODO 5.1 - Replace silent server stubs with explicit browser entrypoint imports

Paths:

- `packages/app-core/src/platform/empty-node-module.ts`
- `packages/app-core/src/browser.ts`
- `packages/app/vite/native-module-stub-plugin.ts`
- `packages/app/vite.config.ts`

Rationale:

Silent noop stubs keep builds green but hide accidental server behavior in renderer code. Once browser-safe entrypoints exist, many stubs should become unnecessary.

Risk level:

- High. Web/mobile renderer builds are sensitive to static import resolution.

Validation command:

```bash
bun run --filter @elizaos/app build:web && bun run --filter @elizaos/app test
```

Dependencies/order:

- After TODO 1.2 and TODO 4.3.

Implementation notes:

- Remove one stub category at a time.
- Prefer throwing stubs for accidental execution.
- Keep a bundle import graph report for each removal.

### TODO 5.2 - Centralize remaining browser stub manifest

Paths:

- `packages/app/vite/native-module-stub-plugin.ts`
- `packages/app-core/src/platform/empty-node-module.ts`
- `packages/app-core/src/platform/elizaos-plugin-elizacloud-browser-stub.ts`

Rationale:

If stubs remain required, they should be declared once with names, reason, and owner.

Risk level:

- Medium. Stub generation or import rewriting can affect builds.

Validation command:

```bash
bun run --filter @elizaos/app build:web && bun run --filter @elizaos/app test:e2e
```

Dependencies/order:

- After TODO 5.1.

Implementation notes:

- Create a manifest keyed by package/module specifier.
- Include runtime behavior: noop, throw, proxy, or named constants.
- Test that manifest exports satisfy current static imports.

## Phase 6 - Package Payload Hygiene

### TODO 6.1 - Split app-core package payload into public runtime and build tooling allowlists

Paths:

- `packages/app-core/package.json`
- `packages/app-core/scripts/copy-package-assets.mjs` usage in package script
- `packages/app-core/scripts/prepare-package-dist.mjs` if it owns filtering
- `packages/app-core/dist`

Rationale:

App-core currently copies broad directories into `dist`. Some are required for published build tooling; others look like test/build leakage.

Risk level:

- High. Published package consumers may rely on copied scripts/platform templates.

Validation command:

```bash
bun run --filter @elizaos/app-core build:dist && bun run --filter @elizaos/app-core pack:dry-run
```

Dependencies/order:

- After TODO 0.3.

Implementation notes:

- First add explicit allowlists and reports without removing files.
- Then remove categories proven unused from the package payload, not from source.

### TODO 6.2 - Exclude test files from app-core dist unless explicitly shipped as fixtures

Paths:

- `packages/app-core/package.json`
- `packages/app-core/tsconfig.build.json`
- `packages/app-core/platforms/electrobun/src/*.test.ts`
- `packages/app-core/scripts/*.test.ts`
- `packages/app-core/test/helpers`

Rationale:

Current local app-core `dist` includes test files under platform/script/test-helper paths. Published runtime packages should not ship test implementation by accident.

Risk level:

- Medium. Some tests may intentionally ship as examples/fixtures.

Validation command:

```bash
bun run --filter @elizaos/app-core build:dist && find packages/app-core/dist -name '*.test.*' -o -name '*.spec.*'
```

Dependencies/order:

- After TODO 6.1.

Implementation notes:

- If any test files are intentional, move them under a named fixtures directory and document them.

### TODO 6.3 - Decide ownership of tracked generated/report files

Paths:

- `packages/app-core/collision-report.json`
- `packages/app-core/platforms/electrobun/.generated/brand-config.json`
- `packages/os/linux/live-build/auto/build`
- `packages/os/linux/live-build/auto/clean`
- `packages/os/linux/live-build/auto/config`

Rationale:

Some tracked files look generated by name/path, while live-build `auto/*` files are source control scripts. Ownership should be documented to avoid accidental cleanup.

Risk level:

- Low to medium.

Validation command:

```bash
git ls-files packages/app-core/collision-report.json packages/app-core/platforms/electrobun/.generated/brand-config.json packages/os/linux/live-build/auto
```

Dependencies/order:

- Can run any time after Phase 0.

Implementation notes:

- Move generated reports under `docs/` or regenerate them as CI artifacts.
- If `.generated/brand-config.json` is canonical, add a README in that directory.
- Do not treat `live-build/auto/*` as disposable build output.

## Phase 7 - iOS Native Runtime and Dependency Ownership

### TODO 7.1 - Define a single manifest for full-Bun iOS engine staging

Paths:

- `packages/bun-ios-runtime/package.json`
- `packages/bun-ios-runtime/BRIDGE_CONTRACT.md`
- `packages/bun-ios-runtime/ElizaBunEngine.podspec`
- `packages/native-plugins/bun-runtime/package.json`
- `packages/native-plugins/bun-runtime/ElizaosCapacitorBunRuntime.podspec`
- `packages/app-core/scripts/run-mobile-build.mjs`

Rationale:

Full-Bun framework path, ABI symbol names, deployment target, and staging requirements are currently known by both `bun-ios-runtime` and app-core mobile build orchestration.

Risk level:

- High. iOS local mode depends on exact framework and ABI staging.

Validation command:

```bash
bun run --cwd packages/bun-ios-runtime check && ELIZA_IOS_FULL_BUN_ENGINE=1 bun run --filter @elizaos/app build:ios:local:sim
```

Dependencies/order:

- Before moving code between runtime/native plugin packages.

Implementation notes:

- Add a JSON manifest or exported script API from `@elizaos/bun-ios-runtime`.
- Make `run-mobile-build.mjs` consume the manifest instead of duplicating constants.

### TODO 7.2 - Finish sqlite-vec ownership decision

Paths:

- `packages/ios-native-deps/package.json`
- `packages/ios-native-deps/sqlite-vec/README.md`
- `packages/native-plugins/bun-runtime/`
- `packages/app-core/scripts/run-mobile-build.mjs`

Rationale:

`build:sqlite-vec` is currently a TODO echo. The package documents sqlite-vec as required for on-device vector storage but does not provide a build script.

Risk level:

- Medium. It may be future-facing, but leaving a package script placeholder is ambiguous.

Validation command:

```bash
bun run --cwd packages/ios-native-deps build:sqlite-vec
```

Dependencies/order:

- After TODO 7.1 if sqlite-vec is staged into full-Bun runtime.

Implementation notes:

- Either implement the build or mark sqlite-vec as explicitly pending outside package scripts.
- Document consumer package and expected output path.

### TODO 7.3 - Make native dependency products consumable by native plugin package APIs

Paths:

- `packages/ios-native-deps/README.md`
- `packages/ios-native-deps/llama.cpp/build-ios.sh`
- `packages/native-plugins/bun-runtime/ElizaosCapacitorBunRuntime.podspec`
- `packages/native-plugins/llama/`
- `packages/app-core/scripts/run-mobile-build.mjs`

Rationale:

Native dependency build products should be consumed through stable package paths/manifests, not through app-core script knowledge of output layouts.

Risk level:

- High for iOS local/native inference builds.

Validation command:

```bash
bun run --cwd packages/ios-native-deps build:llama-cpp:simulator && bun run --filter @elizaos/app build:ios:local:sim
```

Dependencies/order:

- After TODO 7.1.

Implementation notes:

- Keep generated `dist/` and `artifacts/` ignored.
- Make staging path override env vars explicit and documented.

## Phase 8 - App Integration Shell Cleanup

### TODO 8.1 - Generate an app dependency report from `app.config.ts`

Paths:

- `packages/app/app.config.ts`
- `packages/app/package.json`
- `packages/app/src/main.tsx`
- `packages/app/vite.config.ts`

Rationale:

The app package declares many app/native/plugin dependencies and side-effect imports. A report should distinguish app-config-owned defaults from always-installed shell dependencies.

Risk level:

- Low. Report-only.

Validation command:

```bash
bun run --filter @elizaos/app typecheck
```

Dependencies/order:

- Before changing app dependencies or side-effect imports.

Implementation notes:

- Report categories: app plugins, core plugins, native plugins, UI/runtime deps, test-only deps.
- Do not remove dependencies in the same PR as the report.

### TODO 8.2 - Move plugin side-effect imports behind explicit app registration

Paths:

- `packages/app/src/main.tsx`
- `packages/app/app.config.ts`
- `packages/app/vite.config.ts`
- Plugin app packages under `plugins/app-*`

Rationale:

Side-effect imports make the app shell the implicit plugin registry. Explicit app registration from config or a generated module makes ownership and ordering clearer.

Risk level:

- High. App startup and plugin registration can regress.

Validation command:

```bash
bun run --filter @elizaos/app build:web && bun run --filter @elizaos/app test:e2e
```

Dependencies/order:

- After TODO 8.1.

Implementation notes:

- Generate a registration module first while preserving the same imported packages.
- Add startup smoke tests before removing direct side-effect imports.

### TODO 8.3 - Separate app web build stubs from mobile-native build behavior

Paths:

- `packages/app/vite/native-module-stub-plugin.ts`
- `packages/app/vite.config.ts`
- `packages/app/capacitor.config.ts`

Rationale:

The Vite stub plugin handles web, desktop, and mobile differences in one place. Separating web-only server stubs from mobile-native plugin handling will reduce accidental mobile regressions.

Risk level:

- Medium to high. Vite resolution behavior is fragile.

Validation command:

```bash
bun run --filter @elizaos/app build:web && bun run --filter @elizaos/app build:ios:local:sim && bun run --filter @elizaos/app build:android
```

Dependencies/order:

- After TODO 5.2 and TODO 3.1.

Implementation notes:

- Keep current behavior as snapshots/tests before splitting.
- Add tests for mobile builds preserving native plugin imports.

## Phase 9 - OS Package Safety

### TODO 9.1 - Add cleanup-safe documentation for `packages/os`

Paths:

- `packages/os/README.md` if added
- `packages/os/linux/README.md`
- `packages/os/linux/live-build/README.md`
- `packages/os/package.json`

Rationale:

`packages/os` is a distro source tree, not a normal JS package. Automated cleanup can misread `live-build/auto/build` as generated output.

Risk level:

- Low.

Validation command:

```bash
git ls-files packages/os/linux/live-build/auto && bun test packages/os/linux/agent/tests
```

Dependencies/order:

- Can run independently.

Implementation notes:

- Explicitly call out tracked source/control paths versus generated build output.
- Keep package private.

### TODO 9.2 - Add generated output ignore/report coverage for OS builds

Paths:

- `.gitignore`
- `packages/os/linux/live-build/`
- `packages/os/android/vendor`

Rationale:

OS builds can produce large artifacts. The repo should document and ignore generated outputs without ignoring canonical vendor/source files.

Risk level:

- Medium. Bad ignore rules could hide source files.

Validation command:

```bash
git check-ignore -v packages/os/linux/live-build/auto/build || true && git status --ignored --short packages/os | sed -n '1,120p'
```

Dependencies/order:

- After TODO 9.1.

Implementation notes:

- Never add broad ignores that match `live-build/auto/*`.
- Prefer explicit generated output directories.

## Phase 10 - Final Prune Candidates After Validation

These are not deletion instructions. They are candidates to evaluate only after the previous checks are in place.

### TODO 10.1 - Evaluate app-core root compatibility exports for deprecation

Paths:

- `packages/app-core/src/index.ts`
- `packages/app-core/src/browser.ts`
- `packages/app-core/src/ui-compat.ts`

Rationale:

After consumers move to explicit entrypoints, root compatibility exports can be documented as deprecated or reduced in a major-version window.

Risk level:

- High. Public API impact.

Validation command:

```bash
rg "from [\"']@elizaos/app-core[\"']|import\\([\"']@elizaos/app-core[\"']\\)" packages plugins cloud
```

Dependencies/order:

- After TODO 1.1 through TODO 1.3 and TODO 4.3.

### TODO 10.2 - Evaluate unused native plugin package declarations

Paths:

- `packages/app/package.json`
- `packages/app-core/package.json`
- `packages/native-plugins/*/package.json`

Rationale:

Once inventory and config ownership are explicit, dependencies that are neither registered nor imported can be removed from the owning manifest in a dedicated cleanup PR.

Risk level:

- Medium.

Validation command:

```bash
bun install --frozen-lockfile && bun run --filter @elizaos/app typecheck && bun run --filter @elizaos/app cap:sync
```

Dependencies/order:

- After TODO 3.1 through TODO 3.3.

### TODO 10.3 - Evaluate app-core dist test payload pruning

Paths:

- `packages/app-core/dist`
- `packages/app-core/package.json`
- `packages/app-core/tsconfig.build.json`

Rationale:

The publish artifact should not contain test files unless they are intentional fixtures.

Risk level:

- Medium.

Validation command:

```bash
bun run --filter @elizaos/app-core build:dist && bun run --filter @elizaos/app-core pack:dry-run
```

Dependencies/order:

- After TODO 6.1 and TODO 6.2.

## Suggested PR Slices

1. Guardrail PR:
   - TODO 0.1, TODO 0.2, TODO 0.3.
2. App-core entrypoint PR:
   - TODO 1.1, TODO 1.2, TODO 1.3.
3. Electrobun boundary PR:
   - TODO 2.1, TODO 2.2, TODO 2.3 documentation only if needed.
4. Native inventory PR:
   - TODO 3.1, TODO 3.2, TODO 3.3 report mode.
5. Contract consolidation PR:
   - TODO 4.1, TODO 4.2, then TODO 4.3 by domain.
6. Stub reduction PRs:
   - TODO 5.1 one stub family at a time, then TODO 5.2.
7. Package payload PR:
   - TODO 6.1 report-to-allowlist, then TODO 6.2.
8. iOS ownership PR:
   - TODO 7.1, TODO 7.2, TODO 7.3.
9. OS package safety PR:
   - TODO 9.1, TODO 9.2.
10. Final prune PRs:
   - TODO 10.1, TODO 10.2, TODO 10.3 only after all validations pass.

