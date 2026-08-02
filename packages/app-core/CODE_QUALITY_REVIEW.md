# `@elizaos/app-core` code-quality review

## Executive summary

`app-core` works, but it has become a second application platform rather than a focused shared package. It owns CLI policy, the dashboard HTTP compatibility layer, agent boot and repair, onboarding deferral, native shells, mobile sandboxing, account brokering, deployment, packaging, release automation, voice tooling, and large real-E2E harnesses. The package contains about 1,900 tracked files and 261,000 lines of tracked TypeScript/JavaScript. That breadth is now its main maintainability risk.

This pass implemented the highest-risk startup corrections instead of leaving them as recommendations. The global `node:http` monkey-patch is gone; compatibility behavior is explicit middleware on one concrete server. Process signals and exit codes are owned by the CLI boundary. A typed startup state machine now drives lifecycle/status projection. Compatibility state is per-server, startup failures close bound resources, deferred feature failures become an observable degraded phase, and a real reset-route E2E is no longer dark.

The major work that remains is decomposition, not emergency correctness repair: `runtime/eliza.ts` and `api/server.ts` are still oversized, compatibility routes need consumer-led retirement, and native/build/release tooling should eventually become separate workspaces.

## Cleanup and refactoring completed

- Removed about 11.9 GB of ignored generated output: the Bun/RISC-V build cache, Electrobun build output, `app-core/dist`, and a stray generated `test/eliza-package-paths.d.ts` plus source map. These outputs are reproducible and were not tracked.
- The verification pass removed another roughly 790 MB of regenerated Electrobun release artifacts/probes, the runtime skill catalog cache, local PGlite test state, Pods, Python bytecode, native library outputs, and package build output. Installed dependencies and the repository-managed iOS artifact bundle were preserved.
- Confirmed that the remaining tracked declaration files are source inputs, not compiler debris:
  - `vite-env.d.ts` supplies Vite ambient types.
  - `platforms/electrobun/src/types/web-speech.d.ts` supplies missing Web Speech declarations.
- Fixed the `run` alias selecting one-shot CLI crash behavior while `start` selected supervised long-running behavior.
- Consolidated duplicate `start`/`run` Commander registration.
- Made missing `dotenv` fail fast because it is a required package dependency.
- Removed a redundant side-effect import and corrected the stale `tsdown` entry-point comment.
- Fixed a duplicated `ELIZA_SKIP_LOCAL_UPSTREAMS` condition.
- Preserved causes when autonomy startup and enablement fail.
- Removed three silent service-stop catches; shutdown retains an annotated, observable best-effort catch.
- Fixed `eliza dashboard` to find `packages/app`, use Bun, and honor the shared UI-port resolver. The previous `apps/app` path does not exist in this repository.
- Fixed `eliza doctor` to enforce the package's Node 24 requirement and use environment-aware API/UI ports.
- Removed a hardcoded API port from the capability-router CLI default.
- Repaired five live-E2E imports that referenced deleted `packages/test/helpers` modules instead of local app-core helpers.
- Made Knip include all Vitest configs and exclude the ignored Bun/RISC-V source cache, turning thousands of false dependency findings into a small actionable list.
- Removed a developer-specific `/home/shaw/...` fallback from the Android voice build and personal repository paths from the UI smoke fixture.
- Added explicit `requestMiddleware` and `configureServer` extension points to `@elizaos/agent`; app-core no longer assigns to or restores `http.createServer`.
- Scoped compatibility runtime state and device-bridge attachment to the returned HTTP server instance.
- Added a typed, transition-validated startup state machine covering API bind, onboarding deferral, runtime boot, feature startup, ready/degraded, stopping, and failure.
- Added a server-only lifecycle handle and moved SIGINT/SIGTERM, shutdown timeout, and exit-code policy into the CLI registration boundary. Removed the artificial keep-alive interval and direct-run behavior from `runtime/eliza.ts`.
- Made initial boot close the already-bound API server on failure and made close idempotent and complete (HTTP listener, sandbox registration, runtime, and trigger bridge).
- Removed dead config-file synchronization that resolved source and destination to the same path yet ran after every response.
- Removed an unused SQL table-introspection helper and the unused direct `undici` dependency.
- Removed the dead Shopify live-test switch and its nonexistent dynamic import.
- Converted trigger-bridge and connector-catalog startup from log-and-continue to an observable post-ready failure. Background SQL and sandbox registration failures now call `runtime.reportError`.
- Made agent reset fail explicitly on runtime-stop timeout, unexpected database paths, deletion failures, config persistence failures, or secure-store cleanup failures instead of returning partial success.
- Activated and fixed the real reset-route E2E lane by renaming its previously excluded file and making the app-real config inherit app-core's workspace aliases.
- Deleted the machine-specific iOS `Podfile.lock`, ignored regenerated locks, and normalize Android Capacitor settings to portable `require.resolve` lookups after sync.
- Added `check:source-artifacts`, which rejects accidental `.d.ts` and `.d.ts.map` files outside generated output while allowing the two intentional ambient declarations.
- Excluded Pods, temporary build probes, and test/spec files from copied package assets. Dry-run unpacked size fell from 78.2 MB/1,509 files to 33.6 MB/1,378 files; the tarball fell from 34.7 MB to 26.5 MB.
- Moved post-ready tail, trigger-bridge, and connector-catalog handles into per-runtime boot resources. Multiple embedded hosts no longer supersede or tear down each other's resources, and failed runtime repair shuts down the unpublished runtime before surfacing the original failure.
- Removed the obsolete Edge TTS fallback stack. `plugin-edge-tts` is no longer a workspace package; local voice ownership stays with local inference, while Cloud TTS remains at its explicit server boundary. Stale dependencies, aliases, Docker entries, declarations, and orchestrator requirements were removed with it.
- Removed stale `plugin-streaming` and `plugin-x402` references from app-core Docker, Electrobun, TypeScript, Vitest, and setup paths after confirming those workspace directories do not exist.
- Made Android LP3 policy helpers independent of the importing repository's ambient app identity. Production audits pass the active whitelabel ID explicitly, while canonical policy tests remain deterministic in nested consumer checkouts.

## How agent startup currently works

1. `src/entry.ts` mutates logging, color, cloud-key, database, and profile environment state before dynamically importing the CLI.
2. `src/cli/run-main.ts` loads `.env`, installs a global restart callback and process-level crash policy, builds Commander, lazily registers a selected sub-CLI, and parses arguments.
3. `src/cli/program/register.start.ts` resolves remote-access security, then dynamically imports `startEliza` with `serverOnly: true`.
4. `src/runtime/eliza.ts` enables the orchestrator by default, starts optional embedding warmup, resolves ports, creates the startup state machine, and decides whether onboarding defers runtime boot.
5. It starts the app-core API wrapper before the runtime so the renderer can connect while the agent boots.
6. `src/api/server.ts` passes an explicit compatibility middleware and concrete-server configurator to `@elizaos/agent`; unmatched requests delegate once to the upstream route kernel.
7. Runtime boot calls the upstream agent boot, repairs SQL compatibility, installs registry boot hooks, initializes autonomy, and either awaits or backgrounds a post-ready tail.
8. The post-ready tail registers app routes, runtime hooks, credential bridges, trigger handling, connector catalogs, and voice warmup. A failure marks lifecycle `degraded` and is reported to the runtime.
9. The runtime returns a server-only host handle. `register.start.ts` owns process signals, shutdown timeout, and exit; the host owns only its resources.

This sequence optimizes time-to-first-render, but it has too many owners and implicit ordering constraints.

## Priority findings

### Resolved P0: replace the global HTTP monkey-patch

Implemented. `@elizaos/agent` accepts an explicit request middleware and concrete-server configurator. App-core composes caller hooks, owns one compatibility state object per server, and attaches the device bridge only to that server. Regression tests assert `http.createServer` identity remains unchanged across start/close and exercise both skip-listen and real bind paths.

### Resolved P0: establish one startup state machine

Implemented for host lifecycle and status projection with validated transitions and attempt tracking. Initial boot, onboarding-triggered boot, restart, bind failure, boot failure, post-ready completion/failure, and shutdown publish through the same machine. Remaining refinement: route groups still need explicit readiness metadata so feature routes can return structured `503 feature_starting` rather than relying only on lifecycle/status polling.

### Resolved P0: remove process ownership from the runtime library

Implemented. The runtime returns a `ServerOnlyHost` through the startup callback. `register.start.ts` installs the process owner, while the runtime contains no signal handlers, `process.exit`, or dummy timer. Focused tests cover single-flight shutdown, signal removal, timeout exit, close failure, and idempotent host close.

### P1: split `runtime/eliza.ts` by responsibility

Suggested extraction boundaries:

- `startup/app-runtime-host.ts`: orchestration and state machine only.
- `startup/server-only-host.ts`: API bind, runtime swap, restart, and close.
- `startup/post-ready.ts`: typed contributor pipeline and readiness reporting.
- `startup/autonomy.ts`: autonomy service and bootstrap entities.
- `startup/pglite-recovery.ts`: error classification, quarantine, and retry.
- `startup/local-model-warmup.ts`: embedding and voice policy.
- `startup/app-contributors.ts`: registry module resolution and contributor loading.

Keep dependency direction one-way: the host composes these modules; helpers do not mutate process state or module-global runtime slots.

### P1: split `api/server.ts` and delete compatibility routing over time

The server module still combines route dispatch, CORS, status rewriting, PGlite cleanup, cloud configuration, and wallet hydration. Route ownership is difficult to audit because `handleCompatRouteInner` is a long ordered chain and several route families exist only for historical compatibility.

The global patch and per-response config synchronization are removed. The remaining work is structural: create a route manifest with path/method/auth/readiness metadata, register route families directly, and track compatibility endpoints with consumers and removal dates before deleting them.

### P1: complete error-policy compliance

The current tree contains 211 catches in `src` and 80 `error-policy:J*` annotations. A proximity scan still finds 181 catches across 70 files without a nearby justification; the largest concentrations are `cli/plugins-cli.ts`, `api/ios-local-agent-transport.ts`, `api/secrets-manager-routes.ts`, and `runtime/dev-server.ts`. The startup/server paths changed in this pass now fail fast or carry a justification. Post-swap SQL and sandbox registration call `runtime.reportError`; trigger/catalog failures propagate to the degraded feature phase; reset no longer reports partial success.

The rest of `src` still needs a package-wide boundary audit rather than mechanical annotation. Inner helpers should throw `ElizaError` with cause/context, deferred work should update feature state and report errors, and teardown catches should be observable J6 handlers.

### P1: stop tracking machine-specific native dependency resolution

Implemented. Android settings resolve Capacitor packages through Node at Gradle evaluation time, and the mobile sync script normalizes regenerated output idempotently. The tracked iOS lock containing absolute paths is deleted and regenerated locks are ignored. The Android native-plugin verifier passes 19/19 required compiled plugins.

### P1: repair dependency and dead-code governance

The unused `undici` dependency, dead Shopify switch/import, broken live-test imports, and two duplicate exports are removed. Knip now scans all Vitest configs, excludes generated caches, records required external binaries, and recognizes the two `scripts/build.mjs` spawn-command false positives. The package-scoped scan exits successfully with configuration-tightening hints only. Remaining governance work is to reduce the broad `ignoreDependencies` list carefully as packaging is split out.

### P1: decompose the build and release scripts

`scripts/run-mobile-build.mjs` is about 8,700 lines. Other large scripts include the 5,000-line UI smoke API stub, 2,900-line AOSP compiler, 2,700-line runtime dependency copier, and 1,800-line desktop build. These scripts contain policy, process execution, filesystem mutation, dependency discovery, platform branching, and validation in single files.

Extract pure policy modules first, then platform adapters and command runners. Give each script a small entrypoint with typed options and a returned result. Replace ad-hoc executable discovery with one shared toolchain resolver. Tests should target pure modules plus a small number of real build smoke tests.

### P2: reduce package scope and published payload

The build still copies `scripts`, `platforms`, `packaging`, `patches`, and selected test helpers into `dist`. Generated Pods, temporary probes, and test/spec sources are now excluded, reducing unpacked payload by 57%. The remaining 33.6 MB is dominated by three byte-identical 7.2 MB iOS splash scale assets. Changing that asset catalog needs native visual/build verification, so it was not treated as blind file cleanup.

Consider separate workspaces for:

- `@elizaos/app-core`: runtime contracts and host composition;
- `@elizaos/app-cli`: Commander and process entry;
- `@elizaos/app-server`: dashboard API integration;
- `@elizaos/app-native`: native shell sources and bridges;
- `@elizaos/app-packaging`: release/build tooling.

At minimum, publish an explicit asset manifest instead of copying entire top-level directories.

### P2: reduce weak types and singleton state

Static scanning found 53 `as never` uses and 87 broad `any`/double-cast patterns in `src`. Many occur where runtime service registries do not express app-specific services. Extend the core registry typing or add typed app-core adapters instead of repeatedly casting service names and values.

Shared compatibility runtime and signal-registration globals are gone. Trigger bridges, connector catalogs, and post-ready tail ownership are isolated in a `WeakMap` keyed by the concrete runtime, and shutdown disposes only that runtime's resources. Remaining weak typing is concentrated at service-registry boundaries rather than host ownership.

### P2: consolidate port and environment policy

This review fixed hardcoded CLI defaults, but production source still contains direct defaults in `server-cors.ts`, comments and fixtures repeat 2138/31337, and numerous scripts have their own port selection. All runtime-facing code should call `resolveRuntimePorts`, and all aliases should go through `readAliasedEnv`. Create one test matrix for canonical and branded variables, invalid values, conflicts, fallback ports, and actual rebound ports.

### P2: clean comments and generated-file boundaries

Many important files have good explanatory headers, but older scripts still use filename/status-history headers, change narration, phase labels, and comments such as "byte-identical" or "previous dynamic import was ineffective." Rewrite these as durable invariants when those files are next changed. Mark generated files consistently, keep generators next to schemas/templates, and add a generated-output check so compiled declarations cannot reappear in source/test directories.

## Files that may be removable after consumer checks

Do not delete these solely from a filename scan. Verify imports, package exports, native build references, and release scripts first.

- `src/ui-compat.ts`: explicitly labeled legacy; inventory external importers and remove the export in a major release.
- `src/registry/index.ts`: one-line compatibility re-export; migrate remaining consumers to `@elizaos/registry/first-party`.
- compatibility route modules under `src/api/*-compat-routes.ts`: remove route-by-route after telemetry/consumer migration.
- iOS splash scale copies: byte-identical and responsible for roughly 21.6 MB unpacked, but remove/consolidate only with an Xcode/Capacitor launch-screen verification matrix.

The two tracked `.d.ts` files are not deletion candidates without replacement because they provide ambient source declarations.

## Recommended implementation order

1. Split runtime and server modules along the boundaries above without changing the new lifecycle contract.
2. Add route metadata and structured readiness failures for post-ready feature routes.
3. Inventory compatibility-route consumers and remove shims route-by-route.
4. Split build/native/packaging workspaces and replace broad asset-directory copying with an explicit manifest.
5. Consolidate iOS splash assets with real native launch-screen evidence.
6. Run the remaining package-wide error-policy and weak-type audit after module ownership is clear.
7. Tighten Knip dependency ignores as packaging dependencies move to their owning workspace.

## Verification notes

- The complete package build passed, including declaration generation, filtered asset copying, package preparation, and ESM import rewriting.
- The full suite passes with module isolation: 193 files passed and 1 intentionally skipped; 1,571 tests passed and 15 skipped. Focused startup, Android policy/audit, reset, view-provenance, local-inference, and multi-account failover regressions also pass.
- Package typecheck, Biome lint, Biome format, and `check:source-artifacts` pass. The source tree contains exactly two intentional ambient declarations and no compiler debris.
- Package-scoped Knip exits successfully; its only output is the existing `.css` compiled-extension configuration hint.
- Android native-plugin verification passes 19/19 required compiled plugins. It reports two present-but-undeclared modules that correctly will not ship.
- The dry-run package is 26.5 MB compressed, 33.6 MB unpacked, and 1,364 files (previously 34.7 MB, 78.2 MB, and 1,509 files).
- The default non-isolated Vitest mode completed once with only the three Anthropic clean-checkout failures fixed here, but a subsequent repetition deadlocked in idle coordinator/worker IPC under concurrent repository test load. The isolated run completed cleanly; removing the package's `isolate: false` test coupling remains a test-infrastructure cleanup item.
- The updated mobile documentation passes all 23 documentation integrity, navigation, and link tests.
- No `packages/app` UI code changed, so the app screenshot audit is not applicable to this cleanup.
