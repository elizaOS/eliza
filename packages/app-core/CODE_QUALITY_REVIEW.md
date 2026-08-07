# `@elizaos/app-core` code-quality review

## Final status

The safe cleanup and startup refactor are complete. The package now has explicit
owners for process policy, server-only hosting, runtime repair, contributors,
model warmup, database recovery, and post-ready work. The public
`runtime/eliza.ts` composition layer is 223 lines, down from roughly 2,100.

The package is still intentionally broad: 1,920 tracked files and roughly
260,000 tracked TypeScript/JavaScript lines cover the application host, native
shells, packaging, release tooling, and real integration harnesses. Splitting
those product areas into new workspaces is a versioning and ownership project,
not a safe deletion or mechanical cleanup.

## Implemented cleanup

### Startup and ownership

- Replaced the global `node:http` monkey-patch with explicit agent-server
  middleware and concrete-server hooks.
- Scoped compatibility state and native bridge attachment to each server.
- Moved process signals, shutdown timeout, and exit status to the CLI boundary.
- Added a transition-validated startup state machine and structured deferred
  feature readiness.
- Closed the bound API server when initial runtime boot fails and made host close
  idempotent across the API listener, sandbox registration, runtime, trigger
  bridge, and connector catalog.
- Split startup into focused modules:
  - `startup/app-contributors.ts`: registry route plugins, runtime hooks, boot
    hooks, optional module resolution, and route deferral/skip policy.
  - `startup/app-runtime-host.ts`: SQL repair, autonomy ordering, post-ready
    phase reporting, runtime-scoped resources, and repair failure cleanup.
  - `startup/server-only-host.ts`: bind-first API startup, onboarding deferral,
    runtime publication/restart, sandbox registration, and close.
  - `startup/pglite-recovery.ts`: database error classification, quarantine,
    and retry policy.
  - `startup/local-model-warmup.ts`: embedding and voice warmup policy.
  - `startup/autonomy.ts`: autonomy bootstrap and service initialization.
  - `startup/post-ready.ts`: ordered post-ready steps and liveness guards.
- Preserved existing public exports from `runtime/eliza.ts` while moving their
  implementation behind these boundaries.

### API, errors, and compatibility

- Added structured `503 feature_starting` and `feature_unavailable` responses
  for known deferred feature-route prefixes.
- Removed per-response config synchronization and an unused SQL introspection
  helper.
- Made agent reset fail on runtime-stop timeout, unsafe database paths, deletion,
  persistence, or secure-store failures instead of reporting partial success.
- Made trigger/catalog failures observable and reported diagnostic background
  failures through `runtime.reportError`.
- Completed the `plugins-cli.ts` error-policy pass: Commander actions are
  explicit J1 boundaries, invalid plugin candidates are explicit J3 results,
  missing optional config is visible J4 degradation, config-load failures no
  longer fabricate empty config, and editor launch failures are no longer
  swallowed.
- Migrated in-repository registry consumers to
  `@elizaos/registry/first-party`; the app-core subpath remains a documented
  compatibility export.

### Dependencies, artifacts, and packaging

- Removed obsolete Edge TTS, streaming, x402, Shopify-test, and unused
  `undici` references after confirming their packages or consumers were gone.
- Repaired live-test imports and Knip coverage. Package-scoped Knip exits zero;
  its only hint is the known CSS compiled-extension notice.
- Added `check:source-artifacts`. The only source declarations are intentional:
  `vite-env.d.ts` and Electrobun's Web Speech ambient declarations.
- Removed generated declarations, source maps, Pods, caches, build output, and
  duplicate iOS splash payloads. One 2732×2732 splash remains because the launch
  storyboard consumes that catalog.
- Replaced the long package copy command with the tested
  `scripts/copy-publish-assets.mjs` manifest. Asset additions now have one
  reviewable contract; the shared copier still excludes generated/build/test
  artifacts inside those roots.
- The final dry pack is 11.3 MB compressed and 18.3 MB unpacked with 1,387 files,
  down from 34.7 MB compressed and 78.2 MB unpacked.
- Made Android Capacitor resolution portable and removed the machine-specific
  iOS dependency lock.

## Current startup sequence

1. `entry.ts` establishes logging and environment policy, then loads the CLI.
2. `cli/run-main.ts` loads dotenv, installs process crash policy, builds
   Commander, and selects the requested command.
3. `register.start.ts` validates remote-access policy, invokes `startEliza`, and
   owns signals, shutdown timeout, and exit status.
4. `runtime/eliza.ts` applies app-host capabilities and composes upstream agent
   boot with the focused startup modules.
5. `startup/server-only-host.ts` binds the API before runtime boot so the UI can
   render an observable loading/onboarding state.
6. `startup/app-runtime-host.ts` repairs the runtime, runs registry boot hooks,
   initializes autonomy, and starts or awaits the post-ready tail.
7. Deferred app routes, runtime hooks, credential bridges, trigger handling,
   connector catalog, and voice warmup complete the feature phase. Failure moves
   lifecycle to `degraded` and is reported to the runtime.

The dependency direction is one-way: the public composition layer calls focused
startup modules; those modules do not own process signals or exit behavior.

## Files reviewed for deletion

No additional file is safely removable solely as cleanup:

- `src/ui-compat.ts` is still consumed by dynamic UI view loading and guarded by
  bundle-contract tests.
- `src/registry/index.ts` is now only a public compatibility surface. Removal
  requires a major-version export change and external notice.
- Compatibility route modules remain active HTTP contracts and must be retired
  route-by-route with consumer evidence.
- The two source `.d.ts` files provide ambient types and are protected by the
  source-artifact check.
- The remaining splash image is referenced by the iOS launch asset catalog.

## Deliberate architectural projects, not cleanup residuals

These items should not be folded into a cleanup change because they alter
workspace ownership, public exports, release pipelines, or external HTTP
contracts:

1. **Compatibility API extraction and retirement.** `src/api/server.ts` is still
   1,139 lines and contains the ordered compatibility manifest. Moving the
   manifest is behavior-preserving, but deleting entries requires consumer
   telemetry, method/auth contract tests, deprecation dates, and a major API
   decision.
2. **Workspace decomposition.** CLI, API host, native shells, and packaging could
   become `@elizaos/app-cli`, `app-server`, `app-native`, and
   `app-packaging`. That migration changes package exports, downstream imports,
   release ownership, and artifact assembly and should have its own design and
   compatibility plan.
3. **Build-script decomposition.** `run-mobile-build.mjs` remains about 8,700
   lines. Its pure policy, platform adapters, staging, tool execution, and
   artifact verification should be extracted incrementally with real iOS and
   Android build evidence. The publish manifest completed the safe payload part
   of this finding.
4. **Repository-wide error-policy migration.** Production `src` currently has
   233 catches; 109 have a nearby J1-J7 annotation and 124 predate the policy.
   The previously largest concentration, `plugins-cli.ts`, is complete. The next
   concentrations are platform secure storage, account-pool metering, first-run,
   doctor/auth commands, and steward/mobile services. These require semantic
   boundary review rather than blanket annotations.
5. **Service-registry typing.** Static scanning now finds 11 broad cast/`any`
   patterns in production source, including 8 `as never` service-registry
   adaptations. Eliminating them cleanly requires typed registry support in
   `@elizaos/core`, not more local assertions.

## Verification

- Package typecheck: passed.
- Focused plugin CLI and publish-manifest tests: 8/8 passed.
- Startup-focused tests: 48/48 passed.
- Full isolated package suite: 196 files passed, 1 skipped; 1,575 tests passed,
  18 intentionally skipped.
- Root `bun run verify`: passed all 340 workspace typecheck/lint tasks and every
  repository audit.
- Package build, declaration flattening, publish-manifest copying, package
  preparation, and ESM import rewriting: passed.
- Biome lint and formatting: passed.
- Source-artifact audit: passed with exactly two intentional declarations.
- Package-scoped Knip: exits zero with one informational CSS hint.
- Android native-plugin verification: 19/19 required plugins passed.
- iOS asset catalog: compiled successfully with Apple `actool`. A full native
  link still requires generated CocoaPods configuration in this checkout.
- Dry npm package: 11.3 MB compressed, 18.3 MB unpacked, 1,387 files.
- No `packages/app` UI behavior was changed by this cleanup, so the app visual
  audit is not applicable.

Ignored Electrobun build output may be recreated by active desktop/Playwright
lanes. It is excluded from git and npm packaging and should only be removed when
no live process is consuming it.
