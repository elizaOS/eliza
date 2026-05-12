# Repo Cleanup Validation Status

Date: 2026-05-12

This file records the current validation state after the dry-run cleanup
research waves, broad repo checks, and the first limited high-confidence
cleanup batch. The original waves were inventory-only; the follow-up batch
deleted no-reference LifeOps/app-core/plugin shims, removed dead Discord compat
symbols, consolidated one duplicate UI helper into shared, added
generated-output ignore rules, and removed ignored untracked inference
verification outputs.

## Current Results

| Check | Status | Notes |
| --- | --- | --- |
| `bun run lint` | Pass | Revalidated after cleanup. Completed across the Turbo package graph plus examples/benchmarks. The personality benchmark still reports non-fatal Biome warnings in `src/judge/checks/phrase.ts`. |
| `bun run typecheck` | Pass | Revalidated after cleanup and again after the UI/shared compatibility re-export consolidations. A parallel run raced with `bun run build` while `@elizaos/app-steward` was rebuilding and failed in `@elizaos/app`; rerunning typecheck alone completed the main Turbo graph and examples/benchmarks successfully. |
| `bun run build` | Pass | Revalidated after cleanup. Completed 190 Turbo build tasks plus examples/benchmarks. Existing warnings remain: `types` export conditions after `default`, PGlite direct `eval`, ineffective dynamic imports, plugin timing warnings, and intentional skipped example builds. |
| `bun run --cwd packages/app-core build` | Pass | Revalidated after deleting the unused `agent-browser-stub.ts` file. |
| `bun run --cwd packages/app-core typecheck` | Pass | Revalidated after deleting the unused `agent-browser-stub.ts` file. The first parallel attempt raced with `build` while `dist/` was being cleaned; the solo rerun passed. |
| `bun run --cwd plugins/plugin-discord typecheck` | Pass | Revalidated after removing unused compat runtime proxy symbols. |
| `bun run --cwd plugins/plugin-discord build` | Pass | Revalidated after removing unused compat runtime proxy symbols. |
| `bun run --cwd plugins/plugin-discord test` | Blocked | 6 files and 30 tests pass, then `actions/messageConnector.test.ts` fails during module load because optional native package `@snazzah/davey` cannot load its binding from `voice.ts`. |
| `bun run --cwd plugins/plugin-coding-tools typecheck` | Pass | Revalidated after deleting the stale local `execution-mode.ts` duplicate. |
| `bun run --cwd plugins/plugin-coding-tools build` | Pass | Revalidated after deleting the stale local `execution-mode.ts` duplicate. |
| `bun run --cwd plugins/plugin-coding-tools test` | Pass | `13 files`, `95 tests passed`; package export-order warning only. |
| `bun run --cwd plugins/plugin-shell build` | Pass | Revalidated after deleting the stale local `executionMode.ts` duplicate. |
| `bun run --cwd plugins/plugin-shell typecheck` | Skipped | Package script currently prints `Typecheck skipped for release`. |
| `bun run --cwd plugins/plugin-shell test` | Pass | `2 files`, `6 tests passed`; package export-order warning only. |
| `bun run --cwd plugins/plugin-aosp-local-inference typecheck` | Pass | Revalidated after removing the obsolete `@ts-ignore` around the guarded `bun:ffi` dynamic import. |
| `bun run --cwd plugins/plugin-aosp-local-inference build` | Pass | Package build script completed after the suppression cleanup. |
| `bun run --cwd packages/shared typecheck` | Pass | Revalidated while consolidating SQL compat ownership into shared. |
| `bun run --cwd packages/shared build` | Pass | Revalidated while consolidating SQL compat ownership into shared. |
| `bun run --cwd packages/ui lint` | Pass | Revalidated after formatting the UI compatibility re-export files. |
| `bun run --cwd packages/ui typecheck` | Pass | Revalidated after replacing the duplicate SQL compat implementation with a UI compatibility re-export. |
| `bun run --cwd packages/ui build` | Pass | Revalidated after replacing the duplicate browser-tab registry implementation with a UI compatibility re-export. |
| `bun run --cwd packages/ui test -- src/components/pages/browser-workspace-wallet-injection.test.ts` | Pass | `1 file`, `3 tests passed`; validates the preload-script consumer after the browser-tab registry consolidation. |
| Focused DFlash app-core tests | Pass | `5 passed`, `23 tests passed` for the cache-flow and stress files that were previously failing. |
| `bun run --cwd plugins/app-lifeops lint:default-packs` | Pass | Validated the LifeOps default-pack surface after deleting `resolver-shim.ts`. |
| `bun run --cwd plugins/app-lifeops build:types` | Pass | Validated LifeOps types after deleting `resolver-shim.ts`. |
| `bun run --cwd plugins/app-lifeops test` | Pass | `57 files`, `548 passed`, `1 skipped`; warnings were package export-order and sourcemap warnings only. |
| `bunx madge --circular ...` | Pass | Processed 7,529 files with 143 warnings and found no circular dependencies. |
| `git diff --check` | Pass | No whitespace errors in the current diff. |
| `bun run knip` | Blocked | Fails before repo analysis because `@oxc-resolver/binding-darwin-arm64` cannot be loaded: macOS rejects the native module signature with different Team IDs. |
| `bun run test` | Blocked | Cloud SDK and agent suites pass, then app-core Vitest hangs. The worker spins at about 93% CPU for minutes after the Electrobun test-file list; the run was terminated with code 143. |

## Cleanup Batch 1

Implemented changes:

- Deleted `plugins/app-lifeops/src/lifeops/entities/resolver-shim.ts` after
  exact-path reference scans found no live imports.
- Deleted `packages/app-core/src/platform/agent-browser-stub.ts` after exact
  reference scans found the active renderer aliases use
  `platform/empty-node-module.ts`, not this older stub.
- Removed unused `createCompatRuntime()` and private `addServerId()` from
  `plugins/plugin-discord/compat.ts`, along with stale cleanup comments, after
  exact symbol scans found no live references.
- Deleted `plugins/plugin-coding-tools/src/lib/execution-mode.ts` and
  `plugins/plugin-shell/utils/executionMode.ts`; live code already imports the
  canonical runtime-mode helpers from `@elizaos/shared`.
- Removed the obsolete `@ts-ignore` and matching Biome suppression around the
  guarded `bun:ffi` dynamic import in
  `plugins/plugin-aosp-local-inference/src/aosp-llama-adapter.ts`.
- Replaced the byte-identical SQL compatibility implementation in
  `packages/ui/src/utils/sql-compat.ts` with a public compatibility re-export
  from `@elizaos/shared`.
- Replaced the byte-identical browser-tab registry implementation in
  `packages/ui/src/utils/browser-tabs-renderer-registry.ts` with a public
  compatibility re-export from `@elizaos/shared`.
- Added ignore rules for generated mobile bundle output:
  `packages/agent/dist-mobile-ios/` and
  `packages/agent/dist-mobile-ios-jsc/`.
- Added ignore rules for generated inference verification output:
  `packages/inference/reports/`, `packages/inference/verify/bench_results/`,
  `packages/inference/verify/hardware-results/`,
  `packages/inference/verify/android-vulkan-smoke/`, and the compiled
  verification binaries rebuilt by `packages/inference/verify/Makefile`.
- Deleted tracked generated native executables from
  `packages/inference/verify/`: `cpu_bench`, `cpu_simd_bench`, `cuda_verify`,
  `dispatch_smoke`, `metal_bench`, and `vulkan_dispatch_smoke`.
- Removed ignored untracked inference verification outputs with a reviewed
  `git clean -ndX` dry run followed by scoped `git clean -fdX`.

Left for review:

- `packages/inference/verify/vad_from_wav_example.mjs` is untracked but
  source-like, so it was not deleted with generated outputs.

## DFlash Test-Fixture Fix

Production now requires positive speculative-decoding counters for every
Eliza-1 generation when the loaded plan includes a drafter model. The app-core
mock llama-server only incremented `n_drafted_total` and `n_accepted_total`
for warm cache hits, so cold requests failed before the cache behavior could
be tested.

Changed files:

- `packages/app-core/src/services/local-inference/dflash-cache-flow.test.ts`
- `packages/app-core/src/services/local-inference/__stress__/cache-stress-helpers.ts`

Result:

- `bun run test -- --no-file-parallelism src/services/local-inference/dflash-cache-flow.test.ts src/services/local-inference/__stress__/cache-100conv-stress.test.ts src/services/local-inference/__stress__/cache-restart-corruption.test.ts src/services/local-inference/__stress__/cache-thrash.test.ts src/services/local-inference/__stress__/cache-multi-model.test.ts`
- `5 passed`, `23 tests passed`

## Current Dirty Files

The current worktree contains cleanup deltas from this pass, the intentional
DFlash fixture change, and additional tracked deltas observed before this
cleanup batch. Review these before creating an implementation branch; do not
batch unrelated changes blindly with cleanup deletions.

Cleanup deltas:

- `.gitignore`
- `docs/audits/repo-cleanup-2026-05-11/README.md`
- `docs/audits/repo-cleanup-2026-05-11/SUMMARY.md`
- `docs/audits/repo-cleanup-2026-05-11/VALIDATION_STATUS.md`
- `docs/audits/repo-cleanup-2026-05-11/phase-4-*.md`
- `packages/app-core/src/platform/agent-browser-stub.ts` deleted
- `packages/ui/src/utils/sql-compat.ts`
- `packages/ui/src/utils/browser-tabs-renderer-registry.ts`
- `plugins/plugin-aosp-local-inference/src/aosp-llama-adapter.ts`
- `plugins/plugin-coding-tools/src/lib/execution-mode.ts` deleted
- `plugins/plugin-discord/compat.ts`
- `plugins/plugin-shell/utils/executionMode.ts` deleted
- `plugins/app-lifeops/src/lifeops/entities/resolver-shim.ts` deleted
- `packages/inference/verify/{cpu_bench,cpu_simd_bench,cuda_verify,dispatch_smoke,metal_bench,vulkan_dispatch_smoke}` deleted
- `packages/inference/verify/vad_from_wav_example.mjs` untracked, review only

Tracked inference evidence deltas left for owner review:

- `packages/inference/verify/Makefile`
- `packages/inference/verify/bench_results/cpu_simd_m4max_2026-05-12.json`
- `packages/inference/verify/bench_results/m4max_fused_2026-05-12.json`

Previously observed tracked deltas:

- `packages/app-core/src/services/local-inference/dflash-cache-flow.test.ts`
- `packages/app-core/src/services/local-inference/__stress__/cache-stress-helpers.ts`
- `packages/app-core/scripts/playwright-ui-live-stack.ts`
- `packages/app-core/scripts/playwright-ui-smoke-api-stub.mjs`
- `packages/app-core/src/services/local-inference/voice/turn-controller.test.ts`
- `packages/app/test/ui-smoke/all-pages-clicksafe.spec.ts`
- `packages/app/test/ui-smoke/apps-utility-interactions.spec.ts`
- `packages/elizaos/templates-manifest.json`
- `packages/ui/src/navigation/index.ts`
- `packages/ui/src/state/useChatCallbacks.ts`
- `packages/examples/browser-extension/safari/Chat with Webpage/Shared (App)/Assets.xcassets/**`
- `packages/examples/browser-extension/safari/Chat with Webpage/Shared (App)/Resources/{Script.js,Style.css}`

Before implementation approval, decide whether to keep these non-DFlash deltas
in the cleanup branch or move them to a separate validation/tooling branch.

## Remaining Validation Blockers

### Knip Native Binding

`bun run knip` invokes `scripts/knip-workspaces.mjs`, but Knip cannot start
because `oxc-resolver` fails to load its native binding:

- Node: `v24.14.0`
- Binding: `@oxc-resolver/binding-darwin-arm64/resolver.darwin-arm64.node`
- Failure: code signature is not valid for use in process because the mapping
  process and mapped file have different Team IDs.

Next options:

- Reinstall dependencies in a clean environment and rerun `bun run knip`.
- Run Knip in Linux CI/container to avoid this macOS code-signing path.
- If macOS local validation is required, rehydrate or re-sign the native
  binding, then rerun the repo wrapper.

### App-Core Root Test Hang

`bun run test` reaches app-core and then stalls after the Electrobun test-file
section. A focused investigation reproduced the app-core segment with a 90s
cap and found the last active file was
`packages/app-core/test/helpers/__tests__/live-agent-test.smoke.test.ts`,
which starts the real live-agent harness and an `AgentRuntime`.

Likely cause:

- `scripts/run-all-tests.mjs` defaults child `ELIZA_LIVE_TEST` to `1`.
- `live-agent-test.smoke.test.ts` calls `describeLive`, but its filename is not
  excluded by the app-core `*.live.test.ts` pattern.
- `packages/app-core/vitest.config.ts` still discovers Electrobun tests under
  `platforms/electrobun`; several import `bun:test`, while the Electrobun
  package script runs Vitest.

The hung run had these processes before termination:

- `scripts/run-all-tests.mjs`
- `packages/app-core/node_modules/.bin/vitest run --config vitest.config.ts`
- Vitest worker at about 93% CPU
- App-core Playwright live-stack helper processes

Next options:

- Split app-core unit tests from live desktop/UI probes in `run-all-tests.mjs`.
- Rename or reclassify `live-agent-test.smoke.test.ts` as an opt-in live test,
  or add a dedicated env gate.
- Exclude `platforms/electrobun/**` from the app-core unit Vitest config, or
  split Electrobun tests so `bun:test` files run under `bun test`.
- Add a hard timeout or diagnostic reporter for app-core test worker hangs.
- Keep the focused DFlash cache/stress subset in CI while the root app-core
  runner is repaired.

## Cleanup Implementation Gates

Every cleanup batch should meet these gates before merge:

1. Inventory-only dry run: write proposed deletions, renames, consolidations,
   route removals, type moves, and test removals into this audit folder.
2. Approval checkpoint: no file deletion, public route removal, type move, or
   shim removal lands without explicit review of the markdown inventory.
3. Narrow implementation branch: one cleanup family per branch when possible
   so generated assets, test cleanup, type consolidation, and route cleanup do
   not mask each other.
4. Validation per batch: run targeted tests for touched packages, then root
   `bun run lint`, `bun run typecheck`, `bun run build`, Madge, and Knip when
   the Knip environment blocker is cleared.
5. Root test status: until the app-core runner hang is fixed, require focused
   app-core test coverage for touched areas plus a documented root-test
   blocked status.
6. Signoff: record command results, skipped suites, generated file deltas, and
   unresolved risk in this audit folder before merging.

## Highest-Confidence Cleanup Queues

Use the wave and phase reports for file-by-file detail. The current top queues
are:

- Generated/artifact cleanup: tracked mobile bundles, generated prompt/action
  specs, benchmark snapshots, manual QA screenshots, rendered audit HTML,
  vendored shellcheck, Vulkan verification outputs, training datasets, and
  native helper binaries.
- Shim/re-export cleanup: UI `agent-client-type-shim`, compat-route shims, and
  public barrels that only preserve old import paths.
- Backend consolidation: trigger DTO duplication, conversation metadata shape
  duplication, boolean dispatch sentinels, route-registration duplication, and
  LifeOps/health transitional contract re-exports.
- Test cleanup: broken or stale LifeOps scheduler tests, connector setup-routes
  contract tests, skipped startup tests, self-control drift tests, affiliate
  e2e stubs, dummy skip-reason tests, and source-string tests.
- Naming cleanup: replace implementation names containing `unified`,
  `consolidated`, `legacy`, `deprecated`, `shim`, or `compat` with canonical
  names only after import graphs and external API surfaces are checked.
