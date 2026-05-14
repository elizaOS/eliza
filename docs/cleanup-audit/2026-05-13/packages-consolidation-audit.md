# Packages Consolidation Audit

Date: 2026-05-13

Scope: every source package boundary under `packages/`.

This is a cleanup/consolidation audit only. No source package files were
modified or deleted. The only intended write is this report.

## Method

- Inventoried `package.json` files under `packages/`, excluding generated
  package output (`dist`, `.vite`, `build`, `node_modules`) and fixture/vendor
  packages.
- Read package metadata: package name, private/public state, exports, `files`,
  scripts, local workspace dependencies, peer dependencies, optional
  dependencies, and publish/build shape.
- Built a package-level consumer map from `package.json` dependencies across
  root, `packages/`, `plugins/`, and `cloud/`.
- Searched representative import sites for native plugins, platform packages,
  cloud routing, local inference, benchmark helpers, examples, and training.
- Reviewed existing cleanup audit docs in the same dated folder to keep
  terminology aligned.

The source package inventory contains 111 package boundaries. The following
14 `package.json` files were intentionally treated as fixtures or vendored
third-party inputs, not elizaOS package boundaries:

- `packages/app-core/test/contracts/lib/openzeppelin-contracts/**`
- `packages/benchmarks/qwen-claw-bench/data/**`
- `packages/benchmarks/skillsbench/tasks/fix-visual-stability/environment/**`
- `packages/benchmarks/solana/solana-gym-env/**`

## Decision Vocabulary

- **Remain standalone**: keep as its own package and published/private boundary.
- **Move under owner**: package should live under its owning app/plugin/tool
  unless independent publishing is a product requirement.
- **De-workspace**: keep files, but remove from package workspace/publish/test
  graph; treat as example, fixture, or local tool.
- **Merge into shared/core/app-core**: collapse into an existing runtime package.
- **Split contract package**: extract stable types/data/protocols into a small
  dependency-light package while implementation stays elsewhere.
- **Keep private package**: retain package boundary but clearly mark as private
  tooling, not public SDK.

## Executive Summary

The main package graph is usable, but the current `packages/` tree mixes
published runtime packages, app shells, native plugin implementation packages,
desktop/mobile build harnesses, benchmark packages, examples, training
corpora, registry UI, homepage UI, and CLI templates. The cleanup should focus
on ownership boundaries rather than deletion.

Highest-leverage decisions:

1. Keep the core runtime packages (`@elizaos/core`, `@elizaos/app-core`,
   `@elizaos/agent`, `@elizaos/ui`, `@elizaos/shared`, `@elizaos/vault`,
   `@elizaos/skills`) as deliberate package boundaries, but split lightweight
   contracts out of `@elizaos/shared` where they are currently coupled to
   runtime dependencies.
2. Treat `packages/native-plugins/*` as either externally published Capacitor
   packages or owner-colocated native adapters. Several are only consumed by
   one plugin/app and should move under that owner if public publishing is not
   required.
3. Merge `@elizaos/electrobun-carrots` into the Electrobun shell unless it is
   meant to become a public extension SDK.
4. De-workspace or mark private/no-publish for examples and benchmark packages.
   They mostly have no inbound consumers and are currently in `packages/` for
   convenience rather than reusable package semantics.
5. Split local inference contracts: catalog, model types, routing preferences,
   device-bridge protocol, GPU profile schemas, and shared file-path logic are
   used across UI, plugin-local-inference, app-core scripts, training, and
   benchmarks. Implementation should remain in `plugin-local-inference`; stable
   contracts should move to a narrow contract package or explicit subpath.

## Workspace Shape

Root workspaces include:

- `packages/*`
- `packages/benchmarks/lib`
- `packages/benchmarks/interrupt-bench`
- `packages/benchmarks/eliza-1`
- `packages/examples/*`
- `packages/examples/*/*`
- `packages/examples/*/*/*`
- `packages/native-plugins/*`
- `packages/app-core/platforms/*`
- `packages/app-core/deploy/cloud-agent-template`
- `plugins/*`
- `cloud/packages/sdk`

This means many examples and native plugins are in the live workspace graph,
while some nested packages with package.json files are not in root workspaces
(`packages/benchmarks/personality-bench`, `packages/benchmarks/framework`,
`packages/benchmarks/gauntlet/sdk/typescript`, `packages/training/...`, and
CLI template package.json files).

Cleanup TODOs:

- Decide which package.json files are real workspaces versus template/example
  fixtures.
- Add an explicit "not published" convention for example/template package.json
  files.
- Add a package inventory check that flags new nested package.json files unless
  they are declared as workspace, fixture, or template.

## Runtime And Domain Packages

| Package | Current evidence | Decision | Cleanup TODOs |
| --- | --- | --- | --- |
| `@elizaos/core` (`packages/core`) | Public package, exports `dist`, broad runtime dependency set, consumed by root, agent, app-core, examples, scenario-runner, shared, skills, UI, native helpers, and many plugins. Depends on `@elizaos/prompts`. | Remain standalone. Do not merge app/app-core/UI into core. | Keep core as the runtime API. Avoid new dependencies on `@elizaos/shared`; current code already inlines some benchmark/shared values to avoid cycles. Add export snapshots before pruning barrels. |
| `@elizaos/shared` (`packages/shared`) | Public package, exports `dist`; consumed by root, cloud, agent, app-core, app, Electrobun, browser-bridge, scenario-runner, UI, many apps/plugins. Depends on `@elizaos/core`, `drizzle-orm`, `react`, `yaml`, `zod`, optional `figlet`. Root barrel exports `./local-inference/index.js`. | Remain standalone, but split contract subpackages. | Extract dependency-light contracts (`local-inference`, service routing/cloud routing, app/platform contracts) into explicit subpaths or a new contract package. Do not keep adding runtime helpers to the root barrel. |
| `@elizaos/app-core` (`packages/app-core`) | Public package, exports root plus native entrypoint/empty-node-module; consumed by agent, Electrobun, app shell, templates, many app plugins. Depends on agent/core/shared/skills/UI/vault and plugin-local-inference. Optional deps include many Capacitor plugins. | Remain standalone, split internal surfaces. | Define explicit entrypoints for `node`, `browser`, `contracts`, and `platform`. Keep root as temporary compatibility facade. Move platform-only scripts/assets out of runtime exports where possible. |
| `@elizaos/agent` (`packages/agent`) | Public package, exports `dist`; consumed by root devDependency, app-core, `packages/os/linux/agent`, and several app plugins. Depends on core, app-core, shared, skills, vault, and many plugins. | Remain standalone. | Keep as packaging/orchestration boundary. Audit plugin dependency breadth separately; it is a distribution bundle rather than a pure library. |
| `@elizaos/app` (`packages/app`) | Private package, no inbound package consumers. Main app shell; depends on app-core, UI, shared, many app plugins, and nearly every native plugin. | Remain private app package. | Keep out of public package publishing. Consider moving app-only native dependencies behind a generated native-plugin manifest to reduce direct dependency churn. |
| `@elizaos/ui` (`packages/ui`) | Public package, exports many UI subpaths and `dist`; consumed by app-core, app, app plugins, templates. Depends on core, shared, plugin-browser, React/UI libs; optional `@elizaos/capacitor-bun-runtime`. Contains local-inference client services and shims. | Remain standalone, split local-inference client contracts. | Move local-inference type/catalog imports to explicit shared subpaths or a contract package. Keep UI code out of app-core root imports. |
| `@elizaos/vault` (`packages/vault`) | Public package, exports `dist`; consumed by agent, app-core, plugin-browser. Focused dependency set (`@electric-sql/pglite`, keyring). | Remain standalone. | Keep as security/storage boundary. Review whether test helpers should remain public exports. |
| `@elizaos/skills` (`packages/skills`) | Public package, exports `dist/**/*`, `skills/**/*`, README; consumed by agent and app-core. Depends on core and yaml. | Remain standalone, possibly split loader/content later. | If bundled skills grow, split "skill loader/contracts" from "bundled skills content" so consumers can depend on the loader without shipping all skill assets. |
| `@elizaos/prompts` (`packages/prompts`) | Public package, exports `src`, `dist`, `scripts`; only local package consumer is `@elizaos/core`. | Merge into core unless external prompt package publishing is required. | Check npm/download consumers before merging. If kept, make package shape explicit: source package versus generated prompt artifact package. |
| `@elizaos/workflows` (`packages/workflows`) | Public package, exports `dist` and `src`; only local consumer is `@elizaos/plugin-workflow`. | Move under owning plugin or keep as public workflow SDK. | Decide whether this is a true public workflow contract. If not, colocate under `plugins/plugin-workflow` and keep package compatibility only temporarily. |
| `@elizaos/scenario-schema` (`packages/scenario-schema`) | Public tiny package with `index.js` and `index.d.ts`; consumed by root devDependency, scenario-runner, app-lifeops. | Remain standalone contract package. | Add build/test or schema snapshot validation so JS and DTS stay synchronized. |
| `@elizaos/scenario-runner` (`packages/scenario-runner`) | Public package, exports `dist` and `bin`; no inbound package consumers. Depends on app-lifeops, core, plugin-agent-skills, plugin-local-inference, plugin-sql, scenario-schema, shared. | Keep private tool or de-workspace. | If it is CI-only, mark private and keep out of publish. If public, split runner contracts from app-lifeops/plugin-local-inference implementation dependencies. |
| `@elizaos/docs` (`packages/docs`) | Private package, test script only, no local deps or consumers. | De-workspace or keep private docs tool. | Prefer docs tooling outside `packages/` if it is not a published package. |
| `elizaos` (`packages/elizaos`) | Public CLI package, exports `dist`, templates, templates manifest, README. No inbound package consumers. | Remain standalone. | Keep template package.json files as template fixtures, not real workspaces. Add validation that template placeholders are not treated as publishable packages. |
| `@elizaos/browser-bridge-extension` (`packages/browser-bridge`) | Private package, extension build/package scripts, no inbound package consumers. Depends on plugin-browser and shared. | Move under owning browser plugin unless independent extension release needs separate package. | Decide whether extension is a product artifact owned by `plugin-browser`. If yes, colocate build scripts and package metadata there. |
| `@elizaos/cloud-routing` (`packages/cloud-routing`) | Public package, exports `dist`; no runtime deps, peer `zod`; consumers are plugin-streaming, plugin-tailscale, plugin-wallet. Imports show wallet, streaming, and tailscale call `resolveCloudRoute`/`isCloudConnected`. | Remain standalone only if cloud routing is intentionally a low-dep public API; otherwise merge into shared contracts. | If kept, keep dependency-free and document service-routing ownership. If merged, use an explicit `@elizaos/shared/cloud-routing` subpath and preserve old package temporarily. |

## App, Site, Registry, And OS Packages

| Package | Current evidence | Decision | Cleanup TODOs |
| --- | --- | --- | --- |
| `eliza-cloud-agent` (`packages/app-core/deploy/cloud-agent-template`) | Public package, workspace-declared deploy template, no inbound consumers. Depends on core, plugin-sql, plugin-elizacloud, plugin-workflow, tsx. | De-workspace or keep as template fixture. | If used only by deployment scaffolding, move under app-core deploy templates and prevent publish. |
| `eliza-app` (`packages/homepage`) | Private web app, no inbound consumers. | Move out of `packages/` to an app/site folder, or keep private app. | Do not publish. Keep product site CI separate from runtime package CI. |
| `elizaos-plugins` (`packages/registry`) | Public package name but registry tooling only; scripts generate/check/validate registry/site. No inbound consumers. | Keep private tool or move under registry service. | If not meant for npm, mark private. Keep generated registry artifacts out of package publish scope. |
| `vite-react-tailwind-starter` (`packages/registry/site`) | Private Vite site package under registry; no inbound consumers. | Move under `packages/registry/site` as private app, or de-workspace if not needed in root graph. | Rename from starter placeholder; mark owner and CI path explicitly. |
| `@elizaos/distro-android-os` (`packages/os`) | Private distro package with no deps/scripts in package metadata. No inbound consumers. | Keep private distro boundary or de-workspace. | If `packages/os` is a build tree, remove package boundary or add scripts that justify it. |
| `usbeliza-agent` (`packages/os/linux/agent`) | Private package, no inbound consumers. Depends on `@elizaos/agent`, `@elizaos/core`, `node-llama-cpp`. | Move under OS distro ownership and keep private. | It is not in root workspaces; keep that way unless Linux distro CI needs workspace resolution. |

## Platform Packages

| Package | Current evidence | Decision | Cleanup TODOs |
| --- | --- | --- | --- |
| `@elizaos/electrobun` (`packages/app-core/platforms/electrobun`) | Public package, workspace platform build root, no inbound package consumers. Depends on app-core, shared, plugin-browser, `electrobun`, and `@elizaos/electrobun-carrots`. Scripts build/dev/test/preload/native effects. | Remain standalone platform build package, but consider private unless independently released. | Make ownership explicit: either "desktop platform package" or "app-core internal platform". Avoid consumers importing app-core platform deep paths. |
| `@elizaos/electrobun-carrots` (`packages/electrobun-carrots`) | Private package, exports `dist`, single package consumer: `@elizaos/electrobun`. Imports appear in Electrobun `src/native/carrots.ts`, `src/rpc-schema.ts`, and tests. | Merge into Electrobun unless it is a public extension SDK. | Move source under `packages/app-core/platforms/electrobun/src/carrots` or define public SDK goals before keeping package boundary. |
| `@elizaos/bun-ios-runtime` (`packages/bun-ios-runtime`) | Private package, no package.json consumers. Mobile build script special-cases this package and injects `ElizaBunEngine` pod only for full iOS Bun engine builds. | Move under iOS platform owner or de-workspace until fully wired. | If pod package is required, keep private and document build contract. If not, move to `packages/app-core/platforms/ios/runtime`. |
| `@elizaos/ios-native-deps` (`packages/ios-native-deps`) | Public package, no package.json consumers. Scripts build iOS `llama.cpp`; README says bun runtime wire-up is pending. | Move to native build tooling or mark private/de-workspace. | Do not publish as public package until it has package consumers and a stable artifact contract. |

## Native Plugin Packages

Most native plugins share a Capacitor package shape: public package, `exports`
to built `dist`, `files` includes native `android/` and/or `ios/` sources and
podspec/build.gradle, and peer dependency on `@capacitor/core`. That shape is
reasonable for independently published Capacitor plugins. It is expensive if
the only consumer is one app/plugin.

### Native Plugin Decision Table

| Package | Consumers and evidence | Decision | Cleanup TODOs |
| --- | --- | --- | --- |
| `@elizaos/native-activity-tracker` | Consumer: `@elizaos/app-lifeops`. Package depends on `@elizaos/core`; ships Swift helper/native binary assets. | Move under LifeOps unless published standalone. | If LifeOps is the only owner, colocate helper in `plugins/app-lifeops` and keep compatibility package only if needed. |
| `@elizaos/capacitor-agent` | Consumer: `@elizaos/app`. Also injected by mobile build custom pods. | Remain native app-shell package or move under app platform. | Keep standalone only if external apps install it. Otherwise group with app-core mobile platform native plugins. |
| `@elizaos/capacitor-appblocker` | Consumers: app-core optional dependency, app dependency. App-core side-effect registers it in native entrypoints. | Remain if independently published; otherwise move under mobile platform owner. | Clarify appblocker ownership with websiteblocker/app-control plugin surfaces. |
| `@elizaos/capacitor-bun-runtime` | Consumers: app-core optional dependency, app dependency, UI optional dependency. Mobile build includes it when llama or full Bun runtime is enabled. | Remain standalone native runtime adapter. | Tie explicitly to `@elizaos/bun-ios-runtime` or merge package docs/contracts so runtime and native bridge do not drift. |
| `@elizaos/capacitor-calendar` | Consumers: app dependency and `@elizaos/app-lifeops`. iOS pod injected by mobile build. | Move under LifeOps or keep as public platform capability. | If calendar is LifeOps-only behavior, colocate under LifeOps native connectors. If a generic app API, keep standalone and add API contract tests. |
| `@elizaos/capacitor-camera` | Consumers: app-core optional dependency, app dependency. | Remain native platform package if public; otherwise move under app mobile platform. | Ensure camera is not indirectly required by plugin packages without package deps. |
| `@elizaos/capacitor-canvas` | Consumers: app-core optional dependency, app dependency. | Remain native platform package if public; otherwise move under app mobile platform. | If canvas only supports app shell, merge with app platform native bundle. |
| `@elizaos/capacitor-contacts` | Consumers: app-core optional dependency, app dependency, `@elizaos/app-contacts`. Imports in `plugins/app-contacts` UI/providers. | Move under app-contacts unless generic published plugin is desired. | Keep `@elizaos/capacitor-contacts` package as compatibility facade if app-contacts owns the native API. |
| `@elizaos/capacitor-desktop` | Consumer: app dependency. Depends on `@elizaos/app-core`; no native files found in inventory. | Merge into app-core/Electrobun desktop platform. | A native plugin depending on app-core is inverted. Move implementation under desktop platform or convert to contract-only bridge. |
| `@elizaos/capacitor-eliza-tasks` | No package.json consumers. Mobile build still injects `ElizaosCapacitorElizaTasks` pod. | Move under task/LifeOps owner or de-workspace until wired. | Add a real package consumer or remove workspace status; keep files intact until build contract is resolved. |
| `@elizaos/capacitor-gateway` | Consumers: app-core optional dependency, app dependency. Has verify/docgen scripts and larger native surface. | Remain standalone platform capability. | Keep public if gateway is external app API. Add ownership docs linking to gateway/cloud runtime. |
| `@elizaos/capacitor-llama` | Consumer: app dependency. Dynamic import in plugin-local-inference registers mobile loader. Depends on `llama-cpp-capacitor`; peer `@capacitor/core`. | Remain standalone native adapter; split shared contracts. | Move device-bridge message types and KV-cache names to local-inference contract package. Keep native adapter implementation here. |
| `@elizaos/capacitor-location` | Consumers: app-core optional dependency, app dependency. | Remain if public platform capability; otherwise move under app mobile platform. | Decide whether any app/plugin owns location behavior. |
| `@elizaos/macosalarm` | No package.json consumers; depends on `@elizaos/core`; ships Swift helper, bin, scripts. | Move under LifeOps/task plugin or de-workspace. | No current inbound consumer justifies public package boundary. Keep files, but mark private/no-publish unless product needs standalone helper. |
| `@elizaos/capacitor-messages` | Consumers: app-core optional dependency, app dependency, `@elizaos/app-messages`. Imports in `plugins/app-messages`. | Move under app-messages unless public SMS bridge is required. | Colocate native SMS/MMS bridge with app-messages or add public API docs/tests. |
| `@elizaos/capacitor-mobile-agent-bridge` | No package.json consumers. README shows direct import usage only. | De-workspace or move under companion/mobile owner. | Keep files intact; do not publish until app/agent bridge has a package consumer. |
| `@elizaos/capacitor-mobile-signals` | Consumers: app-core optional dependency, app dependency, `@elizaos/app-lifeops`. Imports in LifeOps hooks/components. | Move under LifeOps if only LifeOps uses it; otherwise keep as mobile platform signals package. | Define whether mobile signals are generic app platform events or LifeOps-specific anchors. |
| `@elizaos/capacitor-phone` | Consumers: app-core optional dependency, app dependency, `@elizaos/app-phone`. Imports in phone app view/providers. | Move under app-phone unless public phone bridge is required. | Colocate Android dialer/call-log native code with app-phone or document standalone plugin API. |
| `@elizaos/capacitor-screencapture` | Consumers: app-core optional dependency, app dependency. | Remain public platform capability if external; otherwise app platform native module. | Verify app/plugin ownership before moving. |
| `@elizaos/native-plugin-shared-types` | Private package, no consumers. Exports `src`, no scripts/deps. | Merge into `@elizaos/shared` contracts or remove workspace boundary. | If types are needed, import them from `@elizaos/shared/native-plugin-contracts`; otherwise keep as non-workspace source folder. |
| `@elizaos/capacitor-swabble` | Consumers: app-core optional dependency, app dependency. | Remain if public audio/wake native capability; otherwise move under talkmode/voice owner. | Clarify relationship with talkmode and local-inference voice pipeline. |
| `@elizaos/capacitor-system` | Consumers: app-core optional dependency, app dependency, app-device-settings, app-messages, app-wifi. | Remain standalone. | This is genuinely shared across multiple app plugins. Add stable system status contract tests. |
| `@elizaos/capacitor-talkmode` | Consumers: app-core optional dependency, app dependency. | Remain if public voice conversation native package; otherwise move under voice/local-inference owner. | Clarify split between UI talk mode, native audio, and plugin-local-inference voice. |
| `@elizaos/capacitor-websiteblocker` | Consumers: app-core optional dependency, app dependency. | Remain if public cross-platform blocker; otherwise move under appblocker/app-control owner. | Consider consolidating appblocker and websiteblocker ownership. |
| `@elizaos/capacitor-wifi` | Consumers: app dependency and `@elizaos/app-wifi`. Imports in app-wifi providers/components. | Move under app-wifi unless public Wi-Fi bridge is required. | Colocate native Wi-Fi code with app-wifi or add public API docs/tests. |

### Native Plugin Cross-Cutting TODOs

- Decide which native plugins are public Capacitor packages. Public packages
  should have stable README/API/compat tests and independent publish intent.
- For single-owner native packages, move under the owning plugin/app and leave
  a temporary package facade only if published consumers exist.
- Generate mobile pod/package registration from one manifest instead of
  duplicating deps across app package.json, app-core optionalDependencies, and
  mobile build scripts.
- Move shared native protocol/type definitions into `@elizaos/shared` or a
  dedicated native-contract package; remove `@elizaos/native-plugin-shared-types`
  if it stays unused.

## Local Inference And Shared Contracts

Local inference is spread across several boundaries:

- `@elizaos/shared` owns catalog/types/paths/routing-preferences/verify and
  GPU profile schemas under `src/local-inference*`.
- `@elizaos/ui` has local-inference client services plus shims that re-export
  shared catalog/types/paths/verify.
- `plugins/plugin-local-inference` owns runtime implementation: downloader,
  dflash server, voice, routes, registry, engine, device bridge.
- `@elizaos/capacitor-llama` owns the mobile native adapter and device-side
  bridge client.
- `@elizaos/cloud-routing` owns a small cloud route resolver used by wallet,
  streaming, and tailscale plugins.
- `packages/training` scripts read the shared local-inference catalog as the
  release/source-of-truth model list.
- `@elizaos/bench-eliza-1` dynamically imports shared local-inference paths and
  plugin-local-inference engine.

Evidence:

- UI catalog shim says canonical catalog lives in `@elizaos/shared/local-inference`
  but re-exports from `@elizaos/shared`.
- plugin-local-inference catalog/types/path shims also re-export from
  `@elizaos/shared`.
- `packages/benchmarks/eliza-1/src/engine-resolver.ts` dynamically imports
  `@elizaos/shared/local-inference/paths`, `@elizaos/shared/local-inference/catalog`,
  and `@elizaos/plugin-local-inference/services`.
- app-core imports plugin-local-inference services for phrase chunking, device
  bridge, dev routes, and doctor commands.
- `@elizaos/capacitor-llama` mirrors local-inference loader contracts and
  device-bridge message envelopes in its own source comments/types.

Decision:

- **Split contract package** for local inference. The implementation should
  remain in `plugins/plugin-local-inference`; stable catalog/types/protocols
  should not depend on UI, app-core, or plugin implementation.

Recommended target shape:

- `@elizaos/local-inference-contracts` or `@elizaos/shared/local-inference`
  as an explicit dependency-light subpath:
  - model catalog and tier IDs
  - install/registry paths
  - model/download/readiness types
  - routing preferences
  - GGUF/hash verification primitives
  - GPU profile schema and typed IDs
  - device bridge protocol types
  - KV cache type names and DFlash capability descriptors
- `@elizaos/plugin-local-inference`:
  - runtime engine
  - downloader
  - dflash server
  - voice pipeline
  - routes
  - device bridge server
  - native verify scripts
- `@elizaos/ui`:
  - client API and UI state only
  - no duplicate catalog/types except temporary re-export shims
- `@elizaos/capacitor-llama`:
  - native adapter implementation
  - imports protocol/types from the contract package

Cleanup TODOs:

- Replace UI and plugin-local-inference shims that re-export from the root
  `@elizaos/shared` barrel with explicit local-inference subpath imports.
- Move device bridge message envelope types out of both plugin-local-inference
  and capacitor-llama into the contract package.
- Keep `@elizaos/cloud-routing` separate only if avoiding `@elizaos/shared`
  transitive dependencies is important; otherwise fold it into shared service
  routing contracts.
- Add snapshot tests for catalog exports because training/publishing and runtime
  all consume the same model IDs.

## Benchmark Packages

| Package | Current evidence | Decision | Cleanup TODOs |
| --- | --- | --- | --- |
| `@elizaos/configbench` (`packages/benchmarks/configbench`) | Public package, no inbound consumers, depends on `@elizaos/core`, scripts run benchmarks/tests/typecheck. | Keep private benchmark tool or de-workspace. | Mark private unless it is intended for npm. Keep out of normal publish package set. |
| `@elizaos/bench-eliza-1` (`packages/benchmarks/eliza-1`) | Private package, root script `bench:eliza-1` runs it by cwd, no inbound consumers, exports source subpaths. | Keep private benchmark tool. | Keep workspace only if root scripts/CI need it. Avoid public exports from benchmark package unless used by external bench runners. |
| `evm-skill-runner` (`packages/benchmarks/evm/skill_runner`) | Private package, no inbound consumers, depends on `viem`. | De-workspace local benchmark runner. | Keep as benchmark fixture/tool outside publish graph. |
| `@elizaos/benchmark-framework` (`packages/benchmarks/framework/typescript`) | Public package, no inbound consumers, no deps in manifest. | Keep private or move to benchmark SDK if productized. | If public, add docs/tests/publish intent. Otherwise de-workspace. |
| `@solana-gauntlet/sdk` (`packages/benchmarks/gauntlet/sdk/typescript`) | Public package, no inbound consumers inside repo; README shows `npm install @solana-gauntlet/sdk`; depends on `@solana/web3.js`. | Remain standalone only if externally published SDK. | If not published, mark private and de-workspace. If published, move outside elizaOS runtime packages. |
| `@elizaos/interrupt-bench` (`packages/benchmarks/interrupt-bench`) | Private package, root workspace includes it explicitly, no inbound consumers, depends on core. | Keep private benchmark tool. | Keep root workspace only for CI. No public publish. |
| `@elizaos-benchmarks/lib` (`packages/benchmarks/lib`) | Private package, root devDependency only. Core intentionally avoids runtime dep and mirrors retrieval defaults by hand. | Keep private benchmark support package. | Add sync/snapshot check for values mirrored into runtime. |
| `@elizaos/personality-bench` (`packages/benchmarks/personality-bench`) | Private package, no package consumers. Root scripts run `packages/benchmarks/personality-bench/src/runner.ts` and `bun --filter @elizaos/personality-bench calibrate`. | Keep private benchmark tool; ensure workspace status matches scripts. | Either add it to workspaces intentionally or stop using `--filter` and run by cwd/path. |
| `metrics-dashboard` (`packages/benchmarks/skillsbench/experiments/metrics-dashboard`) | Private Vite/Express dashboard, no inbound consumers. | De-workspace/private experiment app. | Keep under skillsbench, not in publish graph. |

Benchmark family TODOs:

- Convert all benchmark package names that are not published SDKs to private.
- Keep benchmark tools out of normal package publishing.
- Add one benchmark workspace manifest if multiple nested benchmark packages
  must remain in the monorepo build graph.
- Separate benchmark fixtures with `package.json` from package inventory so
  cleanup tooling does not treat them as packages.

## Training Packages

| Package | Current evidence | Decision | Cleanup TODOs |
| --- | --- | --- | --- |
| `@elizaos/scambench` (`packages/training/local-corpora/scambench-github`) | Private JS package with test/lint/typecheck scripts and a Python `pyproject.toml`; no inbound package consumers; not in root workspaces. | Keep as training/corpus tool, not public package. | Treat as training-local tool. Do not add to publish workspace. Consider moving JS scripts under Python project tooling if Bun package boundary is unnecessary. |

Training family notes:

- `packages/training` itself is primarily a Python project (`pyproject.toml`)
  and not a JS package boundary.
- Training scripts reference the shared local-inference catalog and release
  manifest contracts, so local inference contracts need stable exports before
  package moves.
- Do not merge training code into runtime packages. Training owns data prep,
  quantization, eval, and publishing workflows; runtime packages should consume
  only emitted contracts/artifacts.

Cleanup TODOs:

- Keep training package boundaries out of root JS workspace unless CI requires
  them.
- Define a formal runtime/training interface around the Eliza-1 catalog and
  manifest schema.
- Avoid package.json files in corpora unless they are actual runnable tools.

## Example Packages

Every source example package scanned has no inbound package.json consumers.
They all depend outward on core/plugins/frameworks. Root workspaces currently
include `packages/examples/*`, `packages/examples/*/*`, and
`packages/examples/*/*/*`, so examples participate in package graph resolution
even though they are not reusable packages.

Decision for the family:

- **De-workspace by default** and keep as examples/templates.
- Mark all example package.json files private/no-publish unless intentionally
  published as examples.
- Consolidate duplicated example families.

| Package | Current evidence | Decision | Cleanup TODOs |
| --- | --- | --- | --- |
| `@elizaos/plugin-starter` (`packages/examples/_plugin`) | Public package name duplicates template plugin starter; no inbound consumers. | De-workspace example/template. | Remove duplicate with `packages/elizaos/templates/plugin` or keep one canonical starter. |
| `@elizaos/example-a2a-server` | Public, no inbound consumers, depends on core and several plugins plus express. | Example only. | Mark private/no-publish. |
| `@elizaos/example-agent-console` | Private, no inbound consumers, depends on core, plugin-local-inference, openai, sql. | Example/dev tool only. | Keep private; de-workspace unless CI needs it. |
| `@elizaos/example-app-capacitor` | Public wrapper package, no deps, runs backend/frontend/cap sync. | Example workspace wrapper. | Mark private; keep subpackages as app example fixtures. |
| `@elizaos/example-app-capacitor-backend` | Public, no inbound consumers, depends on core and multiple provider/localdb plugins. | Example only. | Mark private/no-publish. |
| `@elizaos/example-app-capacitor-frontend` | Public React frontend, no inbound consumers. | Example only. | Mark private/no-publish. |
| `@elizaos/example-app-electron-workspace` | Public wrapper, no inbound consumers. | Example wrapper. | Mark private/no-publish. |
| `@elizaos/example-app-electron` | Public backend, no inbound consumers, depends on core/provider plugins/electron. | Example only. | Mark private/no-publish. |
| `@elizaos/example-app-electron-renderer` | Public React renderer, no inbound consumers. | Example only. | Mark private/no-publish. |
| `@elizaos/example-autonomous` | Public, no inbound consumers, depends on core/inmemorydb/shell. | Example only. | Mark private/no-publish. |
| `eliza-vrm-demo` | Public VRM demo, no inbound consumers, depends on core/provider plugins/three/VRM. | Example/demo app. | Move to examples outside package workspace or mark private. |
| `@elizaos/aws-examples` | Public, no inbound consumers, AWS deploy scripts. | Example/deployment template. | Mark private/no-publish; consider moving to docs/examples. |
| `@elizaos/example-bluesky` | Public, no inbound consumers, depends on plugin-bluesky/openai/sql. | Example only. | Mark private/no-publish. |
| `@elizaos/example-browser-extension` | Public wrapper, no inbound consumers. | Example wrapper. | Mark private/no-publish. |
| `@elizaos/example-browser-extension-chrome` | Public Chrome extension example, no inbound consumers. | Example only. | Mark private/no-publish. |
| `@elizaos/example-browser-extension-safari` | Public Safari extension example, no inbound consumers. | Example only. | Mark private/no-publish. |
| `@elizaos/example-chat` | Public, no inbound consumers, depends on core/provider plugins/sql. | Example only. | Mark private/no-publish. |
| `elizaos-cloudflare-worker` | Public, no inbound consumers, Cloudflare deploy scripts. | Example/deployment template. | Mark private/no-publish unless intentionally published. |
| `@elizaos/example-code` | Public, no inbound consumers, depends on core/coding/shell/mcp/sql and extra UI deps. | Example only. | Mark private/no-publish; consider moving under coding-tools docs. |
| `@elizaos/example-convex` | Public, no inbound consumers, depends on core/provider plugins/sql/convex. | Example only. | Mark private/no-publish. |
| `@elizaos/example-discord` | Public, no inbound consumers, depends on core/discord/openai/sql. | Example only. | Mark private/no-publish. |
| `elizagotchi` | Public demo, no inbound consumers, depends on core/localdb/React. | Demo app. | Mark private/no-publish. |
| `eliza-multichain-miniapp` | Public Farcaster miniapp, no inbound consumers, not tied to core. | Example/demo app. | De-workspace or move outside `packages/`. |
| `@elizaos/example-farcaster` | Public, no inbound consumers. | Example only. | Mark private/no-publish. |
| `@elizaos/example-form` | Public, no inbound consumers. | Example only. | Mark private/no-publish. |
| `@elizaos/example-game-of-life` | Public, no inbound consumers. | Example only. | Mark private/no-publish. |
| `@elizaos/gcp-examples` | Public, no inbound consumers, deploy scripts. | Example/deployment template. | Mark private/no-publish. |
| `@elizaos-examples/html-eliza` | Public static HTML example, no inbound consumers. | Example only. | Mark private/no-publish. |
| `@elizaos/example-lp-manager` | Public, no inbound consumers, depends on wallet/sql. | Example only. | Mark private/no-publish. |
| `@elizaos/example-mcp-server` | Public, no inbound consumers, depends on MCP SDK. | Example only. | Mark private/no-publish unless used as published MCP starter. |
| `@moltbook/eliza-agent` | Public external/demo package, no inbound consumers. | Move out of core packages or mark external example. | Avoid carrying non-elizaOS app package in publish graph. |
| `bags-claimer` | Public helper under moltbook, no inbound consumers. | Example/helper only. | De-workspace; keep as example-local script. |
| `eliza-next-example` | Public Next example, no inbound consumers. | Example only. | Mark private/no-publish. |
| `eliza-react-example` | Public React example, no inbound consumers. | Example only. | Mark private/no-publish. |
| `@elizaos/example-rest-api-elysia` | Public REST API example, no inbound consumers. | Consolidate with REST API examples. | Keep one REST example package or de-workspace all three framework variants. |
| `@elizaos/example-rest-api-express` | Public REST API example, no inbound consumers. | Consolidate with REST API examples. | Mark private/no-publish. |
| `@elizaos/example-rest-api-hono` | Public REST API example, no inbound consumers. | Consolidate with REST API examples. | Mark private/no-publish. |
| `@elizaos/example-roblox-agent` | Public, no inbound consumers. | Example only. | Mark private/no-publish. |
| `@elizaos/example-telegram` | Public, no inbound consumers. | Example only. | Mark private/no-publish. |
| `@elizaos/example-text-adventure` | Public, no inbound consumers. | Example only. | Mark private/no-publish. |
| `@elizaos/example-tic-tac-toe` | Public, no inbound consumers. | Example only. | Mark private/no-publish. |
| `@elizaos/example-trader-ts` | Public, no inbound consumers, wallet/provider demo. | Example only. | Mark private/no-publish. |
| `@elizaos/example-xai-x` | Public, no inbound consumers. | Example only. | Mark private/no-publish. |
| `@elizaos/vercel-edge-examples` | Public Vercel deployment examples, no inbound consumers. | Example/deployment template. | Mark private/no-publish unless intentionally published. |

Example family TODOs:

- Replace broad example workspace globs with explicit examples tested in CI.
- Mark examples private by default.
- Move examples to top-level `examples/` or `docs/examples/` if they are not
  reusable packages.
- Consolidate duplicate app wrappers and REST framework variants around shared
  docs rather than package boundaries.

## CLI Template Package Boundaries

These package.json files live under `packages/elizaos/templates/**`. They are
template artifacts shipped by the CLI, not runtime packages.

| Package placeholder/name | Current evidence | Decision | Cleanup TODOs |
| --- | --- | --- | --- |
| `__PLUGIN_NAME__` (`templates/min-plugin`) | Placeholder public package; exports `dist`; depends on core. | Keep as template fixture, not workspace. | Ensure package inventory tools ignore placeholder packages. |
| `__APP_NAME__` (`templates/min-project`) | Placeholder public package; exports `dist`; depends on core. | Keep as template fixture. | Keep out of root workspace and publish graph. |
| `@elizaos/plugin-starter` (`templates/plugin`) | Public starter template; duplicates `packages/examples/_plugin` name. | Keep one canonical starter template. | Remove duplicate starter source or document why both exist. |
| `__PROJECT_SLUG__` (`templates/project`) | Placeholder project root with scripts. | Keep as template fixture. | Keep out of package inventory/publish. |
| `__APP_PACKAGE_NAME__` (`templates/project/apps/app`) | Placeholder app package; depends on app-core/core/UI/shared. | Keep as template fixture. | Keep dependency versions generated by CLI, not workspace-resolved during repo package audits. |
| `__ELECTROBUN_PACKAGE_NAME__` (`templates/project/apps/app/electrobun`) | Placeholder Electrobun app package; depends on shared/electrobun. | Keep as template fixture. | Keep aligned with real Electrobun package but do not treat as consumer. |

## Package-By-Package Decision Inventory

This table is the compact inventory of every source package boundary in scope.
Details for high-risk families are expanded above.

| Package | Path | Boundary decision |
| --- | --- | --- |
| `@elizaos/agent` | `packages/agent` | Remain standalone distribution/runtime package. |
| `eliza-cloud-agent` | `packages/app-core/deploy/cloud-agent-template` | De-workspace/template unless independently deployed as package. |
| `@elizaos/app-core` | `packages/app-core` | Remain standalone; split node/browser/contracts/platform subpaths. |
| `@elizaos/electrobun` | `packages/app-core/platforms/electrobun` | Remain platform build package; likely private/internal unless published desktop shell. |
| `@elizaos/app` | `packages/app` | Remain private app shell. |
| `@elizaos/configbench` | `packages/benchmarks/configbench` | Keep private benchmark tool or de-workspace. |
| `@elizaos/bench-eliza-1` | `packages/benchmarks/eliza-1` | Keep private benchmark tool. |
| `evm-skill-runner` | `packages/benchmarks/evm/skill_runner` | De-workspace benchmark runner. |
| `@elizaos/benchmark-framework` | `packages/benchmarks/framework/typescript` | Private/de-workspace unless public benchmark SDK. |
| `@solana-gauntlet/sdk` | `packages/benchmarks/gauntlet/sdk/typescript` | Standalone only if external SDK; otherwise private/de-workspace. |
| `@elizaos/interrupt-bench` | `packages/benchmarks/interrupt-bench` | Keep private benchmark tool. |
| `@elizaos-benchmarks/lib` | `packages/benchmarks/lib` | Keep private benchmark support package. |
| `@elizaos/personality-bench` | `packages/benchmarks/personality-bench` | Keep private benchmark tool; fix workspace/script mismatch. |
| `metrics-dashboard` | `packages/benchmarks/skillsbench/experiments/metrics-dashboard` | De-workspace private dashboard. |
| `@elizaos/browser-bridge-extension` | `packages/browser-bridge` | Move under plugin-browser owner or keep private extension package. |
| `@elizaos/bun-ios-runtime` | `packages/bun-ios-runtime` | Move under iOS platform owner or keep private pod package. |
| `@elizaos/cloud-routing` | `packages/cloud-routing` | Remain small standalone contract or merge into shared cloud routing. |
| `@elizaos/core` | `packages/core` | Remain standalone runtime core. |
| `@elizaos/docs` | `packages/docs` | De-workspace/private docs tool. |
| `@elizaos/electrobun-carrots` | `packages/electrobun-carrots` | Merge into Electrobun unless public SDK. |
| `elizaos` | `packages/elizaos` | Remain standalone CLI package. |
| `__PLUGIN_NAME__` | `packages/elizaos/templates/min-plugin` | Template fixture, not package boundary for cleanup. |
| `__APP_NAME__` | `packages/elizaos/templates/min-project` | Template fixture. |
| `@elizaos/plugin-starter` | `packages/elizaos/templates/plugin` | Template fixture; dedupe with examples starter. |
| `__ELECTROBUN_PACKAGE_NAME__` | `packages/elizaos/templates/project/apps/app/electrobun` | Template fixture. |
| `__APP_PACKAGE_NAME__` | `packages/elizaos/templates/project/apps/app` | Template fixture. |
| `__PROJECT_SLUG__` | `packages/elizaos/templates/project` | Template fixture. |
| `@elizaos/plugin-starter` | `packages/examples/_plugin` | De-workspace duplicate starter example. |
| `@elizaos/example-a2a-server` | `packages/examples/a2a` | Example only; mark private/no-publish. |
| `@elizaos/example-agent-console` | `packages/examples/agent-console` | Private example/dev tool. |
| `@elizaos/example-app-capacitor-backend` | `packages/examples/app/capacitor/backend` | Example only. |
| `@elizaos/example-app-capacitor-frontend` | `packages/examples/app/capacitor/frontend` | Example only. |
| `@elizaos/example-app-capacitor` | `packages/examples/app/capacitor` | Example wrapper only. |
| `@elizaos/example-app-electron` | `packages/examples/app/electron/backend` | Example only. |
| `@elizaos/example-app-electron-renderer` | `packages/examples/app/electron/frontend` | Example only. |
| `@elizaos/example-app-electron-workspace` | `packages/examples/app/electron` | Example wrapper only. |
| `@elizaos/example-autonomous` | `packages/examples/autonomous` | Example only. |
| `eliza-vrm-demo` | `packages/examples/avatar` | Demo app; private/de-workspace. |
| `@elizaos/aws-examples` | `packages/examples/aws` | Deployment example; private/de-workspace. |
| `@elizaos/example-bluesky` | `packages/examples/bluesky` | Example only. |
| `@elizaos/example-browser-extension-chrome` | `packages/examples/browser-extension/chrome` | Example only. |
| `@elizaos/example-browser-extension` | `packages/examples/browser-extension` | Example wrapper only. |
| `@elizaos/example-browser-extension-safari` | `packages/examples/browser-extension/safari` | Example only. |
| `@elizaos/example-chat` | `packages/examples/chat` | Example only. |
| `elizaos-cloudflare-worker` | `packages/examples/cloudflare` | Deployment example; private/de-workspace. |
| `@elizaos/example-code` | `packages/examples/code` | Example only. |
| `@elizaos/example-convex` | `packages/examples/convex` | Example only. |
| `@elizaos/example-discord` | `packages/examples/discord` | Example only. |
| `elizagotchi` | `packages/examples/elizagotchi` | Demo app; private/de-workspace. |
| `eliza-multichain-miniapp` | `packages/examples/farcaster-miniapp` | Demo app; private/de-workspace. |
| `@elizaos/example-farcaster` | `packages/examples/farcaster` | Example only. |
| `@elizaos/example-form` | `packages/examples/form` | Example only. |
| `@elizaos/example-game-of-life` | `packages/examples/game-of-life` | Example only. |
| `@elizaos/gcp-examples` | `packages/examples/gcp` | Deployment example; private/de-workspace. |
| `@elizaos-examples/html-eliza` | `packages/examples/html` | Example only. |
| `@elizaos/example-lp-manager` | `packages/examples/lp-manager` | Example only. |
| `@elizaos/example-mcp-server` | `packages/examples/mcp` | Example only unless public MCP starter. |
| `bags-claimer` | `packages/examples/moltbook/bags-claimer` | Example-local helper; de-workspace. |
| `@moltbook/eliza-agent` | `packages/examples/moltbook` | External/demo example; de-workspace. |
| `eliza-next-example` | `packages/examples/next` | Example only. |
| `eliza-react-example` | `packages/examples/react` | Example only. |
| `@elizaos/example-rest-api-elysia` | `packages/examples/rest-api/elysia` | Example only; consolidate REST examples. |
| `@elizaos/example-rest-api-express` | `packages/examples/rest-api/express` | Example only; consolidate REST examples. |
| `@elizaos/example-rest-api-hono` | `packages/examples/rest-api/hono` | Example only; consolidate REST examples. |
| `@elizaos/example-roblox-agent` | `packages/examples/roblox` | Example only. |
| `@elizaos/example-telegram` | `packages/examples/telegram` | Example only. |
| `@elizaos/example-text-adventure` | `packages/examples/text-adventure` | Example only. |
| `@elizaos/example-tic-tac-toe` | `packages/examples/tic-tac-toe` | Example only. |
| `@elizaos/example-trader-ts` | `packages/examples/trader` | Example only. |
| `@elizaos/example-xai-x` | `packages/examples/twitter-xai` | Example only. |
| `@elizaos/vercel-edge-examples` | `packages/examples/vercel` | Deployment example; private/de-workspace. |
| `eliza-app` | `packages/homepage` | Private site app; move outside package graph or keep private. |
| `@elizaos/ios-native-deps` | `packages/ios-native-deps` | Native build tooling; mark private/de-workspace until real package consumers exist. |
| `@elizaos/native-activity-tracker` | `packages/native-plugins/activity-tracker` | Move under LifeOps unless public native helper. |
| `@elizaos/capacitor-agent` | `packages/native-plugins/agent` | App-shell native package; keep standalone only if public. |
| `@elizaos/capacitor-appblocker` | `packages/native-plugins/appblocker` | App-shell/native capability; clarify owner. |
| `@elizaos/capacitor-bun-runtime` | `packages/native-plugins/bun-runtime` | Remain native runtime bridge; align with bun-ios-runtime. |
| `@elizaos/capacitor-calendar` | `packages/native-plugins/calendar` | Move under LifeOps or keep public calendar bridge. |
| `@elizaos/capacitor-camera` | `packages/native-plugins/camera` | App-shell/native capability; keep if public. |
| `@elizaos/capacitor-canvas` | `packages/native-plugins/canvas` | App-shell/native capability; keep if public. |
| `@elizaos/capacitor-contacts` | `packages/native-plugins/contacts` | Move under app-contacts unless public. |
| `@elizaos/capacitor-desktop` | `packages/native-plugins/desktop` | Merge into app-core/Electrobun desktop platform. |
| `@elizaos/capacitor-eliza-tasks` | `packages/native-plugins/eliza-tasks` | Move under task/LifeOps owner or de-workspace until consumed. |
| `@elizaos/capacitor-gateway` | `packages/native-plugins/gateway` | Keep standalone public platform capability if intentional. |
| `@elizaos/capacitor-llama` | `packages/native-plugins/llama` | Remain native adapter; split shared protocol contracts. |
| `@elizaos/capacitor-location` | `packages/native-plugins/location` | App-shell/native capability; keep if public. |
| `@elizaos/macosalarm` | `packages/native-plugins/macosalarm` | Move under LifeOps/task owner or de-workspace. |
| `@elizaos/capacitor-messages` | `packages/native-plugins/messages` | Move under app-messages unless public. |
| `@elizaos/capacitor-mobile-agent-bridge` | `packages/native-plugins/mobile-agent-bridge` | De-workspace or move under mobile companion owner. |
| `@elizaos/capacitor-mobile-signals` | `packages/native-plugins/mobile-signals` | Move under LifeOps or keep public mobile signals bridge. |
| `@elizaos/capacitor-phone` | `packages/native-plugins/phone` | Move under app-phone unless public. |
| `@elizaos/capacitor-screencapture` | `packages/native-plugins/screencapture` | App-shell/native capability; keep if public. |
| `@elizaos/native-plugin-shared-types` | `packages/native-plugins/shared-types` | Merge into shared/native contracts or remove package boundary. |
| `@elizaos/capacitor-swabble` | `packages/native-plugins/swabble` | Voice/native capability; clarify talkmode/local-inference owner. |
| `@elizaos/capacitor-system` | `packages/native-plugins/system` | Remain standalone shared native capability. |
| `@elizaos/capacitor-talkmode` | `packages/native-plugins/talkmode` | Voice/native capability; clarify owner. |
| `@elizaos/capacitor-websiteblocker` | `packages/native-plugins/websiteblocker` | App-shell/native capability; possibly consolidate with appblocker. |
| `@elizaos/capacitor-wifi` | `packages/native-plugins/wifi` | Move under app-wifi unless public. |
| `usbeliza-agent` | `packages/os/linux/agent` | Private OS distro agent; keep under OS owner. |
| `@elizaos/distro-android-os` | `packages/os` | Private distro boundary; de-workspace if no scripts. |
| `@elizaos/prompts` | `packages/prompts` | Merge into core unless external prompt package is required. |
| `elizaos-plugins` | `packages/registry` | Keep private registry tooling or move under registry owner. |
| `vite-react-tailwind-starter` | `packages/registry/site` | Private registry site; rename and keep out of publish graph. |
| `@elizaos/scenario-runner` | `packages/scenario-runner` | Keep private tool or split scenario contract/runner. |
| `@elizaos/scenario-schema` | `packages/scenario-schema` | Remain standalone contract package. |
| `@elizaos/shared` | `packages/shared` | Remain standalone; split dependency-light contracts. |
| `@elizaos/skills` | `packages/skills` | Remain standalone; possibly split loader from bundled skill content. |
| `@elizaos/scambench` | `packages/training/local-corpora/scambench-github` | Training-local private tool; keep out of publish workspace. |
| `@elizaos/ui` | `packages/ui` | Remain standalone UI package; split local-inference contracts. |
| `@elizaos/vault` | `packages/vault` | Remain standalone security/storage package. |
| `@elizaos/workflows` | `packages/workflows` | Move under plugin-workflow unless public workflow SDK. |

## Cleanup Backlog

### P0: Do Not Delete; Classify First

- Add package-boundary metadata for each package: `published`, `private-tool`,
  `example`, `template`, `fixture`, `native-public`, `native-owned`.
- Add a CI check that reports new package.json boundaries under `packages/`.
- Exclude benchmark fixtures and vendored contracts from package audits.

### P1: Fix Publish/Workspace Risk

- Mark all non-published examples private or remove them from root workspace
  globs.
- Mark benchmark packages private unless they are explicit SDKs.
- Mark `@elizaos/ios-native-deps`, `@elizaos/electrobun`, and registry tooling
  private if they are not published package APIs.
- Deduplicate `@elizaos/plugin-starter` between CLI templates and examples.

### P1: Split Contracts Where Runtime Coupling Is High

- Create or formalize local inference contracts.
- Move device bridge protocol types out of native adapter/runtime comments into
  a shared contract.
- Move native plugin shared types into a real shared/native contract surface or
  remove package boundary.
- Decide whether cloud-routing is standalone or a shared service-routing subpath.

### P2: Native Plugin Ownership Cleanup

- Move single-owner native plugins under owning app/plugin if not public.
- Keep `@elizaos/capacitor-system`, `@elizaos/capacitor-llama`, and possibly
  gateway/bun-runtime as standalone native capability packages.
- Generate native registration and mobile build pod lists from one manifest.
- Add a policy that public native packages must have README/API/compat tests.

### P2: Platform Package Cleanup

- Merge `@elizaos/electrobun-carrots` into Electrobun unless an SDK charter is
  written.
- Move iOS dependency build harnesses under platform build tooling.
- Keep platform build artifacts out of app-core runtime package exports.

### P3: Examples And Training

- Move examples out of `packages/` or out of root workspace globs.
- Consolidate REST examples and app wrapper examples.
- Keep training/corpora packages outside npm publish flow.
- Add doc links from examples to canonical templates rather than duplicating
  package starter code.

