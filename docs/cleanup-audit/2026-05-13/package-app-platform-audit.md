# Package App/Platform Cleanup Audit

Date: 2026-05-13

Scope:

- `packages/app`
- `packages/app-core`
- `packages/app-core/platforms/electrobun`
- `packages/ui`
- `packages/os`
- `packages/electrobun-carrots`
- `packages/bun-ios-runtime`
- `packages/ios-native-deps`
- Referenced native/plugin platform boundaries under `packages/native-plugins` and `plugins/plugin-local-inference`

This is a dry-run cleanup report only. No source files were modified.

## Method

- Scanned package manifests, `tsconfig` path maps, package exports, barrels, and build scripts.
- Searched for boundary smells: direct source path aliases, compatibility shims, fallback/stub code, legacy comments, duplicate types, generated artifacts, and package-local generated output.
- Checked ignored/tracked status for large artifacts and generated folders.
- Reviewed native/plugin ownership touchpoints where target packages import or document native plugin/platform boundaries.

## Executive Summary

The app/platform surface is functional but currently held together by broad barrels, source-level path aliases, duplicated bridge types, and browser stubs that compensate for Node/server imports leaking into renderer bundles. The largest cleanup opportunities are:

1. Split `@elizaos/app-core` into explicit Node/runtime, browser-contract, and platform packaging surfaces.
2. Make Electrobun platform ownership explicit through `@elizaos/electrobun` exports instead of app-core deep paths.
3. Consolidate native plugin registration and iOS runtime/dependency ownership.
4. Replace hand-maintained browser stubs and duplicated RPC/client types with generated or single-source contracts.
5. Audit package `dist` payload composition before publish; app-core currently materializes tests/platform templates/scripts into `dist`.

## Findings

### 1. `@elizaos/app-core` Root Barrel Mixes Node Runtime, API Server, UI Compatibility, and Plugin Re-Exports

Files:

- `packages/app-core/src/index.ts`
- `packages/app-core/src/browser.ts`
- `packages/app-core/src/ui-compat.ts`
- `packages/app/src/main.tsx`

Evidence:

- `packages/app-core/src/index.ts` is labeled "Node/runtime barrel" but exports API server modules, registry, runtime startup, security, services, and `ui-compat`.
- The same file re-exports `ensureLocalInferenceHandler` from `@elizaos/plugin-local-inference/runtime` for compatibility.
- `packages/app-core/src/browser.ts` first re-exports all of `@elizaos/ui`, then reaches through to `./index.ts`, then adds noop React component stubs for removed desktop symbols.
- `packages/app/src/main.tsx` imports bare `@elizaos/app-core`, causing renderer builds to traverse the app-core barrel.

Rationale:

This makes renderer builds depend on server/runtime shapes and forces downstream stubbing. It also makes package ownership unclear: UI surfaces live in `@elizaos/ui`, but app-core still carries UI compatibility exports.

Risk:

- High for bundling. Small app-core server import changes can break Vite/Rollup static analysis.
- Medium for public API. Consumers may depend on accidental root-barrel exports.

Validation needed:

- Build `packages/app` web, iOS, Android, and Electrobun after any split.
- Run `bun run --filter @elizaos/app-core typecheck` and `bun run --filter @elizaos/ui typecheck`.
- Run package export smoke tests from a clean temp app using only declared exports.

Proposed TODOs:

- Define explicit entrypoints: `@elizaos/app-core/node`, `@elizaos/app-core/browser`, `@elizaos/app-core/contracts`, and keep `.` as a compatibility facade only temporarily.
- Move UI compatibility consumers to `@elizaos/ui` imports.
- Add a lint/knip rule preventing renderer code from importing bare `@elizaos/app-core` unless intentionally allowed.

### 2. Browser Stub Surface Is Duplicated and Hand-Maintained

Files:

- `packages/app-core/src/platform/empty-node-module.ts`
- `packages/app-core/src/platform/elizaos-plugin-elizacloud-browser-stub.ts`
- `packages/app/vite/native-module-stub-plugin.ts`
- `packages/app/vite.config.ts`

Evidence:

- `empty-node-module.ts` exports a broad set of noop server symbols and explicit type aliases.
- `native-module-stub-plugin.ts` maintains separate virtual modules for Node builtins, `@elizaos/plugin-elizacloud`, native plugins, `@node-rs/argon2`, `chalk`, `drizzle-orm`, and many plugin packages.
- Comments in both places reference the same browser-stub purpose, but the exported names are not centrally validated.

Rationale:

The stub layer is treating symptoms of server code reaching the browser graph. The two stub mechanisms can drift independently.

Risk:

- High for build stability. Any new named import from a server-only module can require another manual stub export.
- Medium for runtime correctness. Noop stubs can hide accidental browser execution of server-only behavior.

Validation needed:

- Add a browser-bundle import graph check that fails when Node/server packages enter renderer chunks.
- Run Vite dev and production builds with `ELIZA_ELIZA_SOURCE=local` and packaged/dist source modes.

Proposed TODOs:

- Reduce browser graph reach-through first by splitting app-core entrypoints.
- Generate stub exports from a declared manifest if stubs remain necessary.
- Prefer throw-on-call stubs for server-only behavior over silent noops unless a noop is intentionally part of UX.

### 3. Electrobun Platform Package Has Ambiguous Ownership and Export Surface

Files:

- `packages/app-core/platforms/electrobun/package.json`
- `packages/app-core/platforms/electrobun/src/index.ts`
- `packages/app-core/package.json`
- `packages/electrobun-carrots/examples/hello-carrot/README.md`

Evidence:

- `@elizaos/electrobun` has scripts and files but no `main`, `types`, or `exports`.
- `@elizaos/app-core` only exports `.`, `./platform/native-plugin-entrypoints`, and `./platform/empty-node-module`.
- `packages/electrobun-carrots/examples/hello-carrot/README.md` demonstrates importing `getCarrotManager` from `@elizaos/app-core/platforms/electrobun/native/carrots`, which is not an exported app-core subpath.
- App-core build copies `platforms` into `dist`, but that does not make those deep paths valid under the package export map.

Rationale:

The physical location under app-core suggests app-core owns the desktop platform, while the package name `@elizaos/electrobun` suggests a separate owner. Deep import examples bypass package boundaries.

Risk:

- High for external consumers. Node ESM package exports will reject undocumented deep imports.
- Medium for monorepo consumers because TS path aliases may make invalid package paths appear valid locally.

Validation needed:

- From a temp project, try importing documented Electrobun APIs through package export maps only.
- Run `npm pack --dry-run` for app-core and electrobun package and inspect included files.

Proposed TODOs:

- Decide a single owner: either move Electrobun platform into `@elizaos/electrobun` with real exports, or declare app-core subpath exports for supported desktop APIs.
- Update carrot examples to import from the owning package.
- Add an exports-map test for Electrobun and app-core packages.

### 4. Capacitor Native Plugin Registration Is Static in App-Core but Dynamic Elsewhere

Files:

- `packages/app-core/src/platform/native-plugin-entrypoints.ts`
- `packages/app/scripts/capacitor-plugin-names.mjs`
- `packages/app/package.json`
- `packages/native-plugins/*/package.json`

Evidence:

- `native-plugin-entrypoints.ts` manually imports 15 Capacitor packages.
- `packages/app/package.json` depends on additional native plugins not in the side-effect entrypoint, including `@elizaos/capacitor-agent`, `@elizaos/capacitor-calendar`, `@elizaos/capacitor-desktop`, `@elizaos/capacitor-llama`, and `@elizaos/capacitor-wifi`.
- `capacitor-plugin-names.mjs` dynamically scans `packages/native-plugins` for packages with `package.json` and `src/index.ts`.

Rationale:

There are two sources of truth for native plugin inventory. Static registration can miss new plugins or carry removed ones.

Risk:

- Medium to high for mobile boot. A native plugin can be present as a dependency but not side-effect registered.
- Medium for package hygiene. App-core optional dependencies and app dependencies can diverge.

Validation needed:

- Compare generated native plugin list against app-core entrypoint in CI.
- Mobile smoke tests for plugin availability on iOS and Android.

Proposed TODOs:

- Generate `native-plugin-entrypoints.ts` from a manifest or from app config/native plugin package metadata.
- Add an allowlist for intentionally excluded plugins with rationale.
- Move the registration entrypoint closer to the app/mobile build owner if app config decides the plugin set.

### 5. App-Core Publish Payload Appears Too Broad

Files:

- `packages/app-core/package.json`
- `packages/app-core/tsconfig.build.json`
- `packages/app-core/dist`

Evidence:

- `build:dist` copies `src/styles`, `src/registry/entries`, `scripts`, `platforms`, `packaging`, `patches`, `test/scripts`, and `test/helpers` into `dist`.
- Current local `dist` contains `dist/platforms/android`, `dist/platforms/ios`, `dist/platforms/electrobun`, packaging directories, script tests, and helper tests.
- `files` only includes `"dist"`, so anything placed there is package payload unless later filtered by `prepare-package-dist.mjs`.

Rationale:

Some copied assets are likely intentional for packaging/mobile builds. Others, especially compiled test files under `dist/platforms/electrobun/src/*.test.ts`, `dist/scripts/*.test.ts`, and `dist/test/helpers`, look like package bloat or build-leak risk.

Risk:

- Medium for package size and install time.
- Medium for accidental execution/import of test-only helpers.
- Low to medium for IP/licensing if generated platform artifacts are copied without explicit intent.

Validation needed:

- Run `bun run --filter @elizaos/app-core build:dist && bun run --filter @elizaos/app-core pack:dry-run`.
- Inspect tarball file list and size.
- Verify which copied scripts/platform templates are required by published consumers.

Proposed TODOs:

- Split package payload into runtime library vs platform build tooling, or add a package manifest allowlist.
- Exclude `*.test.*` from copied platform/scripts/test-helper payload unless explicitly shipped as fixtures.
- Add a CI tarball budget check for `@elizaos/app-core`.

### 6. `@elizaos/ui` and `@elizaos/app-core` Have a Circular Compatibility Relationship

Files:

- `packages/app-core/src/index.ts`
- `packages/app-core/src/ui-compat.ts`
- `packages/ui/tsconfig.json`
- `packages/ui/tsconfig.build.json`
- `packages/ui/src/api/client-types-core.ts`
- `packages/ui/src/api/client-types-cloud.ts`

Evidence:

- App-core imports and re-exports UI compatibility symbols.
- UI has path aliases back to app-core.
- UI client types import from `@elizaos/core`, `@elizaos/shared`, and plugin types, and app-core API routes import UI types in places such as automation node descriptors.

Rationale:

The intended layering appears to be shared contracts below app-core and UI, but current compatibility exports create app-core/UI interdependence.

Risk:

- High for package build order and declaration generation.
- Medium for accidental renderer/server graph coupling.

Validation needed:

- Build packages from a clean checkout in dependency order.
- Run a circular import/dependency scanner against package-level imports.

Proposed TODOs:

- Move app/UI shared contracts into `@elizaos/shared` or a dedicated contracts entrypoint.
- Deprecate app-core UI compatibility exports and add migration docs.
- Keep UI package imports pointed at contracts, not app-core runtime.

### 7. Carrot Types Are Duplicated Across Core Runtime, RPC Schema, and UI Bridge

Files:

- `packages/electrobun-carrots/src/types.ts`
- `packages/app-core/platforms/electrobun/src/native/carrots.ts`
- `packages/app-core/platforms/electrobun/src/rpc-schema.ts`
- `packages/ui/src/bridge/electrobun-rpc.ts`

Evidence:

- `CarrotPermissionGrant`, `CarrotPermissionTag`, `CarrotListEntry`, and snapshot shapes are defined in `electrobun-carrots`.
- Worker/log/status/install result shapes are repeated in Electrobun native manager, Electrobun RPC schema, and UI bridge as `DesktopCarrot*` types.

Rationale:

The UI bridge and RPC schema should not manually mirror core carrot contract types when a package already owns the domain model.

Risk:

- Medium. Type drift can break desktop settings UI or runtime RPC without compiler errors across package boundaries.

Validation needed:

- Typecheck Electrobun and UI after converting bridge types to imported/shared contract types.
- Add a schema compatibility test for Carrot RPC payloads.

Proposed TODOs:

- Move RPC-safe carrot status/log/install types into `@elizaos/electrobun-carrots`.
- Import those types in Electrobun RPC schema and UI bridge.
- Consider generating renderer bridge types from `ElizaDesktopRPCSchema`.

### 8. Local Ambient and App Plugin Declarations Hide Missing Owning-Package Exports

Files:

- `packages/app-core/src/ambient-modules.d.ts`
- `packages/app/src/types/app-plugin-module-exports.d.ts`
- `packages/ui/vitest.config.ts`

Evidence:

- App-core declares modules for `electrobun/view`, `@elizaos/plugin-groq`, `@elizaos/plugin-edge-tts`, `@elizaos/signal-native`, `qrcode-terminal`, and `jsdom`.
- App declares module exports for app plugin packages such as `@elizaos/app-steward`, `@elizaos/app-task-coordinator`, `@elizaos/app-training`, and `@elizaos/app-vincent`.
- UI test config comments indicate some packages are mocked/aliased because they are not declared deps of `@elizaos/ui`.

Rationale:

Ambient declarations are useful for bootstrapping, but long-term they mask missing package types and unclear ownership.

Risk:

- Medium for public package consumers, who may not have these local ambient declarations.
- Low to medium for internal builds if declarations drift from actual plugin exports.

Validation needed:

- Build a consumer project without repo-level ambient declarations.
- Compare ambient module declarations against real package `exports` and generated `.d.ts`.

Proposed TODOs:

- Move plugin component export declarations into owning app packages.
- Replace broad ambient module declarations with real dependencies or explicit local test-only shims.
- Add a "no unresolved ambient package module" package hygiene check.

### 9. iOS Full-Bun, Llama, and Native Dependency Ownership Is Split Across Too Many Packages

Files:

- `packages/app-core/scripts/run-mobile-build.mjs`
- `packages/bun-ios-runtime/*`
- `packages/ios-native-deps/*`
- `packages/native-plugins/bun-runtime/*`
- `packages/native-plugins/llama/*`

Evidence:

- `run-mobile-build.mjs` knows about `packages/bun-ios-runtime`, expected `ElizaBunEngine.xcframework`, ABI symbols, and iOS staging paths.
- `@elizaos/bun-ios-runtime` owns the full Bun engine build/ABI contract and ignored `artifacts/`.
- `@elizaos/ios-native-deps` owns llama.cpp/sqlite-vec cross-build harnesses and documents pending wire-up for `@elizaos/bun-ios-runtime`.
- `@elizaos/capacitor-bun-runtime` owns the Capacitor API and podspec, while also depending on `LlamaCppCapacitor`.

Rationale:

The split is understandable during migration, but ownership is currently distributed across app-core scripts, runtime package, native dependency harness, and native plugin package.

Risk:

- High for iOS local-mode build reproducibility.
- Medium for future ejection/publishing because consumers must know several package paths and env vars.

Validation needed:

- Run iOS local sim build with and without `ELIZA_IOS_FULL_BUN_ENGINE`.
- Run `bun run --cwd packages/bun-ios-runtime check` and smoke scripts after ownership changes.
- Confirm CocoaPods can resolve staged frameworks from published package mode and workspace/local mode.

Proposed TODOs:

- Make `@elizaos/capacitor-bun-runtime` or `@elizaos/bun-ios-runtime` the single owner of full-Bun framework staging metadata.
- Keep `app-core` mobile build orchestration as a consumer of a stable package API/manifest, not hard-coded package internals.
- Finish or remove the pending `sqlite-vec` build script placeholder.

### 10. App Package Depends on Nearly Every App/Native Plugin

Files:

- `packages/app/package.json`
- `packages/app/app.config.ts`
- `packages/app/src/main.tsx`
- `packages/app/vite.config.ts`

Evidence:

- `packages/app/package.json` lists many app plugins, many Capacitor native plugins, and several core plugins directly.
- `packages/app/src/main.tsx` side-effect imports app plugins such as LifeOps, task coordinator, and wallet.
- `vite.config.ts` contains app-plugin alias generation and native plugin alias/stub handling.

Rationale:

This package is acting as an integration shell, package registry, native container, and browser bundler policy owner. That may be correct for the main app, but it increases cleanup blast radius.

Risk:

- Medium for dependency bloat and slow installs/builds.
- Medium for app forks that need a smaller plugin set.

Validation needed:

- Compare app dependencies to `app.config.ts` default app/plugin declarations.
- Run knip after reducing dependency declarations, with intentional dynamic imports allowlisted.

Proposed TODOs:

- Generate plugin dependency/import surface from app config where possible.
- Split "core shell" dependencies from optional app/plugin packs.
- Keep intentional always-installed packages documented in app config or package comments.

### 11. Large Local Generated Artifacts Exist Inside Target Packages but Are Mostly Ignored

Files/directories:

- `packages/app/dist`
- `packages/app/.vite`
- `packages/app/.turbo`
- `packages/app/test-results`
- `packages/app-core/dist`
- `packages/app-core/.eliza`
- `packages/app-core/skills/.cache/catalog.json`
- `packages/app-core/platforms/electrobun/build`
- `packages/ui/dist`
- `packages/electrobun-carrots/dist`
- `packages/bun-ios-runtime/artifacts/ElizaBunEngine.xcframework`

Evidence:

- Large local files included: 70 MB Bun iOS framework artifact, 70 MB app-core skills cache JSON, 60 MB Electrobun bundled `bun`, 22 MB WASM bundles, local `.elizadb` WAL files, and duplicated app assets.
- `git check-ignore` reports these are ignored by `.gitignore` or package `.gitignore` rules.

Rationale:

No deletion is proposed here, but these directories can confuse audits and local scans. Generated output under package roots also makes accidental `git add -f` risky.

Risk:

- Low for source control because ignored today.
- Medium for local tooling performance and accidental forced commits.

Validation needed:

- Keep `git status --ignored` clean after standard build/test workflows.
- Ensure CI starts from clean checkout and does not depend on local ignored artifacts.

Proposed TODOs:

- Add a documented cleanup command for app/platform generated artifacts.
- Add `git status --ignored --short` checks to release/audit workflows.
- Consider moving large local caches outside package roots where feasible.

### 12. Tracked Generated/Report Files Need Ownership Decisions

Files:

- `packages/app-core/collision-report.json`
- `packages/app-core/platforms/electrobun/.generated/brand-config.json`
- `packages/os/linux/live-build/auto/build`
- `packages/os/linux/live-build/auto/clean`
- `packages/os/linux/live-build/auto/config`

Evidence:

- `collision-report.json` is tracked and has a `generatedAt` timestamp from 2026-04-14.
- `packages/app-core/platforms/electrobun/.generated/brand-config.json` is tracked despite living under `.generated`.
- `packages/os/linux/live-build/auto/*` are tracked live-build control scripts, not accidental build output.

Rationale:

Tracked generated files are sometimes necessary, but their names/locations need clear ownership. `.generated` suggests disposable output, while being tracked suggests canonical source.

Risk:

- Low to medium. Stale generated data can mislead cleanup work; tracked generated files also create merge churn.

Validation needed:

- Regenerate collision report and brand config from documented commands and compare.
- Confirm live-build `auto/*` files are executable/control scripts required by live-build.

Proposed TODOs:

- Move `collision-report.json` under `docs/` or regenerate it in CI as an artifact.
- Rename or relocate tracked Electrobun generated config, or add a README explaining why `.generated/brand-config.json` is canonical.
- Keep `packages/os/linux/live-build/auto/*` tracked but document that these are live-build scripts, not output.

### 13. UI Package Exports Are Broad and Include Wildcard Subpath Fallback

Files:

- `packages/ui/package.json`
- `packages/ui/src/index.ts`
- `packages/ui/src/api/client.ts`

Evidence:

- `packages/ui/package.json` has many explicit subpath exports plus `./*`.
- `packages/ui/src/index.ts` is a large barrel exporting app shell, components, config, content packs, desktop runtime, events, hooks, i18n, onboarding, platform, providers, state, themes, types, utils, voice, and widgets.
- `packages/ui/src/api/client.ts` re-exports many shared and plugin-browser types in a single client surface.

Rationale:

The broad wildcard export preserves compatibility but weakens package boundaries. Consumers can depend on internal paths unintentionally.

Risk:

- Medium for future refactors. Any file move can become semver-visible.

Validation needed:

- Enumerate actual external imports of `@elizaos/ui/*`.
- Check which subpaths are required by app/plugin packages.

Proposed TODOs:

- Generate an allowed public subpath list and warn on non-allowed internal imports.
- Gradually replace `./*` with explicit supported subpaths.
- Split API client types from UI components if non-React packages consume them.

### 14. Large Locale JSON Files Are Legitimate but Worth Watching

Files:

- `packages/ui/src/i18n/locales/en.json`
- `packages/ui/src/i18n/locales/es.json`
- `packages/ui/src/i18n/locales/ko.json`
- `packages/ui/src/i18n/locales/pt.json`
- `packages/ui/src/i18n/locales/tl.json`
- `packages/ui/src/i18n/locales/vi.json`
- `packages/ui/src/i18n/locales/zh-CN.json`

Evidence:

- Seven tracked locale JSON files are each roughly 207 KB to 234 KB.
- Dist copies exist locally under `packages/ui/dist/i18n/locales`.

Rationale:

These are source assets, not generated junk. The cleanup opportunity is package/runtime loading strategy, not deletion.

Risk:

- Low for source control.
- Medium for browser bundle size if all locales are eagerly imported.

Validation needed:

- Inspect production bundle chunks for locale inclusion.
- Verify locale lazy-loading behavior in app shell.

Proposed TODOs:

- Keep locale files, but ensure only selected locale loads at runtime.
- Add bundle-size tracking for i18n chunks.

### 15. `packages/os` Contains Real Distro Sources Mixed With Local Build Output Names

Files/directories:

- `packages/os/package.json`
- `packages/os/linux/live-build`
- `packages/os/linux/live-build/auto/build`
- `packages/os/linux/agent`
- `packages/os/android/vendor`

Evidence:

- `packages/os` is private and described as AOSP vendor trees and distro assets.
- `live-build/auto/build` is tracked even though scans for `build` names flag it.
- `packages/os/linux/agent` is a separate Bun app with its own package.json and tests.

Rationale:

`packages/os` is not a normal JS package. Cleanup tools that treat every `build` path as disposable could misclassify live-build control scripts.

Risk:

- Medium if automated cleanup deletes live-build control scripts.
- Low if documented as distro source.

Validation needed:

- Run live-build dry-run or existing linux tests before any restructuring.
- Confirm which `packages/os/android/vendor` files are canonical source vs generated staging outputs.

Proposed TODOs:

- Add package-local README or comments distinguishing live-build `auto/*` scripts from build output.
- Add cleanup ignore rules that spare live-build control directories.

## Consolidation Opportunities

### Native Platform Ownership

Current owners:

- App shell/native build orchestration: `packages/app` and `packages/app-core/scripts/run-mobile-build.mjs`
- Capacitor plugin JS/Swift surfaces: `packages/native-plugins/*`
- Full Bun engine ABI/build: `packages/bun-ios-runtime`
- iOS llama/sqlite native deps: `packages/ios-native-deps`
- Desktop native managers: `packages/app-core/platforms/electrobun/src/native`

Proposed target:

- `packages/native-plugins/bun-runtime` owns the Capacitor API and declares the runtime engine/dependency manifest it needs.
- `packages/bun-ios-runtime` owns only full-Bun framework production and ABI validation.
- `packages/ios-native-deps` owns native dependency build products with a stable package manifest consumed by native plugins.
- `packages/app-core/scripts/run-mobile-build.mjs` consumes those manifests, instead of hard-coding framework names and package internals.
- `@elizaos/electrobun` owns desktop platform APIs and exports supported native managers/RPC schema.

### Contracts and Types

Candidates to move or generate:

- Carrot RPC/status/log/install types from Electrobun/UI into `@elizaos/electrobun-carrots`.
- UI/app-core shared API client contracts into `@elizaos/shared` or `@elizaos/app-core/contracts`.
- Native plugin inventory into a generated manifest consumed by app-core and app Vite config.
- Browser stubs into a generated compatibility layer or, preferably, remove the need through explicit browser entrypoints.

## Suggested Cleanup Order

1. Add non-invasive checks first:
   - Package exports smoke test.
   - App-core/UI circular dependency scan.
   - App-core tarball file list/budget check.
   - Native plugin inventory diff check.
2. Split app-core browser/node entrypoints without deleting compatibility exports.
3. Move Electrobun supported imports to `@elizaos/electrobun` exports and update examples.
4. Consolidate carrot and desktop RPC bridge types.
5. Consolidate native plugin registration and iOS runtime manifests.
6. Prune package payloads and generated/tracked report files after validation.

## Validation Checklist Before Any Actual Deletion

- `bun run --filter @elizaos/app typecheck`
- `bun run --filter @elizaos/app build:web`
- `bun run --filter @elizaos/app-core typecheck`
- `bun run --filter @elizaos/app-core build:dist`
- `bun run --filter @elizaos/app-core pack:dry-run`
- `bun run --filter @elizaos/ui typecheck`
- `bun run --filter @elizaos/ui build:dist`
- `bun run --filter @elizaos/electrobun typecheck`
- `bun run --filter @elizaos/electrobun-carrots typecheck`
- `bun run --cwd packages/bun-ios-runtime check`
- iOS local simulator build if native runtime ownership changes.
- Android local/system build if native plugin entrypoints change.

## Notes on Concurrent Work

The repository had unrelated dirty files before this report was written, including changes under `packages/app-core/scripts`, `packages/app-core/src`, `packages/ui/src/api`, and `packages/ui/src/bridge`. This audit did not revert or modify those files.
