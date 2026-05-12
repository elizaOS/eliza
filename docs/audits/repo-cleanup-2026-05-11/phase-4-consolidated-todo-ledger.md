# Phase 4 Consolidated TODO Ledger

Workspace: `/Users/shawwalters/eliza-workspace/milady/eliza`
Date: 2026-05-11

This ledger merges the Phase 4 specialist reports into one implementation
queue. It separates proven no-behavior cleanup from public API, package
boundary, artifact, documentation, and validation work that needs a dedicated
change set.

## Source Reports

- `phase-4-markdown-wipe-candidates.md`
- `phase-4-json-data-generated-artifacts.md`
- `phase-4-shims-legacy-reexports-removal.md`
- `phase-4-package-boundaries.md`
- `phase-4-package-family-core.md`
- `phase-4-package-family-lifeops-apps.md`
- `phase-4-package-family-plugins.md`
- `phase-4-package-family-examples-benchmarks-inference-cloud.md`
- `phase-4-ignores-suppressions-quality.md`
- `phase-4-package-by-package-matrix.md`
- `VALIDATION_STATUS.md`

## Completed In This Cleanup Pass

| Item | Change | Source report | Validation |
| --- | --- | --- | --- |
| Delete unreferenced LifeOps resolver shim | Removed `plugins/app-lifeops/src/lifeops/entities/resolver-shim.ts`. | `phase-4-shims-legacy-reexports-removal.md`, `phase-4-package-family-lifeops-apps.md` | `bun run --cwd plugins/app-lifeops lint:default-packs`, `bun run --cwd plugins/app-lifeops build:types`, `bun run --cwd plugins/app-lifeops test` passed. |
| Delete unreferenced app-core browser stub | Removed `packages/app-core/src/platform/agent-browser-stub.ts`; kept the active browser aliases in `empty-node-module.ts` and `elizaos-agent-browser-stub.ts`. | `phase-4-shims-legacy-reexports-removal.md`, `phase-4-package-family-core.md` | Exact `rg` path scan was clean; `bun run --cwd packages/app-core build`, `bun run --cwd packages/app-core typecheck`, and root `bun run typecheck` passed. |
| Remove dead Discord compat runtime proxy | Removed stale cleanup comments plus unused `createCompatRuntime()` and private `addServerId()` from `plugins/plugin-discord/compat.ts`; kept the used compat contract types. | `phase-4-shims-legacy-reexports-removal.md`, `phase-4-package-family-plugins.md` | Exact symbol scan was clean; `bun run --cwd plugins/plugin-discord typecheck`, `bun run --cwd plugins/plugin-discord build`, and root `bun run typecheck` passed. Package tests are blocked by the local optional native `@snazzah/davey` binding before the touched file is exercised. |
| Delete stale coding-tools execution-mode duplicate | Removed `plugins/plugin-coding-tools/src/lib/execution-mode.ts`; live code already imports runtime-mode helpers from `@elizaos/shared`. | `phase-4-shims-legacy-reexports-removal.md` | Exact source scan was clean; `bun run --cwd plugins/plugin-coding-tools typecheck`, `build`, and `test` passed. |
| Delete stale shell execution-mode duplicate | Removed `plugins/plugin-shell/utils/executionMode.ts`; live code already imports runtime-mode helpers from `@elizaos/shared`. | `phase-4-shims-legacy-reexports-removal.md` | Exact source scan was clean; `bun run --cwd plugins/plugin-shell build` and `test` passed; package `typecheck` currently skips for release. |
| Remove obsolete AOSP `@ts-ignore` | Deleted the stale `@ts-ignore` and Biome suppression around the guarded `bun:ffi` dynamic import in `plugins/plugin-aosp-local-inference/src/aosp-llama-adapter.ts`. | `phase-4-ignores-suppressions-quality.md` | Suppression scan is clean; `bun run --cwd plugins/plugin-aosp-local-inference typecheck` and `build` passed. |
| Consolidate UI SQL compat implementation | Replaced the byte-identical implementation in `packages/ui/src/utils/sql-compat.ts` with a public compatibility re-export from `@elizaos/shared`. | `phase-4-package-family-core.md`, `phase-4-shims-legacy-reexports-removal.md` | `bun run --cwd packages/shared typecheck`, `build`, `bun run --cwd packages/ui typecheck`, and `bun run --cwd packages/app-core typecheck` passed. |
| Consolidate UI browser-tab registry implementation | Replaced the byte-identical implementation in `packages/ui/src/utils/browser-tabs-renderer-registry.ts` with a public compatibility re-export from `@elizaos/shared`; left the divergent Electrobun bridge mirror untouched. | `phase-4-ignores-suppressions-quality.md`, `phase-4-package-family-core.md` | `bun run --cwd packages/ui typecheck`, `build`, and `test -- src/components/pages/browser-workspace-wallet-injection.test.ts` passed. |
| Ignore generated inference and mobile bundle output | Added ignore rules for `packages/inference/reports/`, `verify/bench_results/`, `verify/hardware-results/`, `verify/android-vulkan-smoke/`, inference verify compiled binaries, `packages/agent/dist-mobile-ios/`, and `packages/agent/dist-mobile-ios-jsc/`. | `phase-4-json-data-generated-artifacts.md`, `phase-4-package-family-examples-benchmarks-inference-cloud.md`, `phase-4-package-by-package-matrix.md` | `git check-ignore --no-index` confirmed generated paths and verify binaries are ignored. |
| Remove tracked inference verify binaries | Deleted generated native executables `cpu_bench`, `cpu_simd_bench`, `cuda_verify`, `dispatch_smoke`, `metal_bench`, and `vulkan_dispatch_smoke` from `packages/inference/verify/`; sources and Makefile rebuild targets remain. | `phase-4-json-data-generated-artifacts.md`, `phase-4-package-family-examples-benchmarks-inference-cloud.md` | `file` confirmed Mach-O/ELF executables before deletion; existence check confirms binaries are removed. |
| Remove fresh untracked generated inference outputs | Cleaned ignored untracked report/result output under inference report/result folders. | `phase-4-json-data-generated-artifacts.md` | `git clean -ndX packages/inference/reports packages/inference/verify/bench_results packages/inference/verify/hardware-results packages/inference/verify/android-vulkan-smoke` now reports nothing. |

Review still needed:
`packages/inference/verify/vad_from_wav_example.mjs` remains untracked because
it is source-like example harness code, not just JSON/report output.

## P0 - Validation Blockers

1. Fix local Knip execution.
   - Evidence: `VALIDATION_STATUS.md`; `bun run knip` is blocked before
     analysis by `@oxc-resolver/binding-darwin-arm64` macOS signature failure.
   - TODO: repair the local native binding/install state, then run Knip across
     the repo before trusting unused-file decisions.

2. Fix root test hang.
   - Evidence: `VALIDATION_STATUS.md`; root `bun run test` hangs in the
     app-core Vitest segment after other suites progress.
   - TODO: isolate the hanging app-core worker, add timeout/teardown fixes, and
     restore a reliable root test gate.

3. Keep the existing green baseline current.
   - Last known passing gates: `bun run lint`, `bun run typecheck`,
     `bun run build`, focused DFlash tests, source Madge circular scan,
     `git diff --check`.

## P1 - No-Reference Deletes

The initial no-reference delete batch is complete. The next candidates in this
category should come from a fresh Knip run after the local native-binding
blocker is cleared, because the remaining shim/facade work has public API or
package-boundary risk.

## P1 - Artifact And Data Removal

1. Remove local ignored/generated state.
   - Delete or keep ignored locally: `artifacts/`, `benchmark_results/`,
     `packages/benchmarks/benchmark_results/`, `tmp/`, `.cache/`,
     `.pytest_cache/`, `coverage/`, caches/logs, Electrobun/Android build
     outputs, training `.venv`, training local data/corpora, llama.cpp build.
   - Source: `phase-4-json-data-generated-artifacts.md`,
     `phase-4-markdown-wipe-candidates.md`.

2. Split tracked inference outputs.
   - Review and remove generated contents from `packages/inference/reports/`,
     `verify/bench_results/`, `verify/hardware-results/`, and
     `verify/android-vulkan-smoke/`.
   - Preserve durable docs/scripts by moving them to `packages/inference/docs/`,
     `packages/inference/scripts/`, or a curated release-evidence location.
   - Source: `phase-4-json-data-generated-artifacts.md`,
     `phase-4-package-family-examples-benchmarks-inference-cloud.md`.

3. Remove tracked mobile bundles after pipeline fix.
   - Target: `packages/agent/dist-mobile-ios/`,
     `packages/agent/dist-mobile-ios-jsc/`.
   - Required first: ensure mobile/iOS build runs `build-mobile-bundle.mjs`
     before staging.
   - Source: `phase-4-package-family-core.md`,
     `phase-4-json-data-generated-artifacts.md`.

4. Remove root `reports/` from git after promoting durable findings.
   - Current state: tracked, generated, large report tree.
   - Keep distilled decisions under `docs/audits/**` or package docs.
   - Source: `phase-4-json-data-generated-artifacts.md`,
     `phase-4-markdown-wipe-candidates.md`.

5. Shrink or replace vendored OpenZeppelin test dependency.
   - Candidate: docs/audits/PDFs/reports in
     `packages/app-core/test/contracts/lib/openzeppelin-contracts/**`.
   - Preferred: minimal fixture, package install, submodule, or fetch step.
   - Source: `phase-4-package-family-core.md`,
     `phase-4-markdown-wipe-candidates.md`.

6. Review wallet contract artifacts.
   - `OZGovernor.json` is imported by `gov-router.ts`; do not delete until ABI
     ownership is refactored.
   - `TimelockController.json` and `VoteToken.json` look unreferenced but
     should be removed with the contract build workflow.
   - Source: `phase-4-json-data-generated-artifacts.md`.

7. Decide training/benchmark data ownership.
   - Review `packages/benchmarks/**` datasets/assets and
     `plugins/app-training/datasets/*.jsonl`.
   - Move large corpora to external artifacts, Git LFS, submodules, or
     reproducible download scripts.
   - Source: `phase-4-json-data-generated-artifacts.md`,
     `phase-4-package-by-package-matrix.md`.

## P1 - Package Boundary Repair

1. Run manifest normalization as a separate manifest-only change.
   - `bun run fix-deps:check` currently reports 384 dependency spec issues.
   - Run `bun run fix-deps`, review the manifest/lockfile diff, then require
     `fix-deps:check` to pass.
   - Source: `phase-4-package-boundaries.md`.

2. Fix missing declared workspace dependencies.
   - Scan found 179 workspace imports not declared in package manifests.
   - Add runtime deps or move imports to the real owner; add dev deps only for
     intentional tests/scripts.
   - Source: `phase-4-package-boundaries.md`.

3. Remove runtime cross-package relative imports.
   - Scan found 196 cross-package relative imports.
   - Highest priority: app-core reaching into agent tool-call-cache, cloud-lib
     reaching into shared source, cloud db/lib/ui relative imports, companion
     reaching into app-task-coordinator source, app-training/scenario-runner
     importing LifeOps test helpers, UI reaching into shared source.
   - Source: `phase-4-package-boundaries.md`,
     `phase-4-package-family-core.md`.

4. Resolve duplicate package identities.
   - Start with `plugins/plugin-sql/src/package.json` duplicating
     `@elizaos/plugin-sql`.
   - Confirm whether `@elizaos/plugin-starter` duplicates are templates only.
   - Source: `phase-4-package-boundaries.md`.

5. Decide root/cloud workspace ownership.
   - Cloud has 17 cloud-only packages outside root workspaces; root includes
     only `cloud/packages/sdk`.
   - Either document nested cloud workspace ownership or unify the graph.
   - Source: `phase-4-package-boundaries.md`.

6. Contract wildcard exports.
   - Audit packages with `./*` exports, replace with explicit public subpaths,
     then remove now-unreachable shim files.
   - Source: `phase-4-shims-legacy-reexports-removal.md`,
     `phase-4-package-boundaries.md`.

## P1 - Type And Contract Consolidation

1. Make shared the owner for duplicated UI/shared config modules.
   - Duplicates include `allowed-hosts.ts`, `api-key-prefix-hints.ts`,
     `app-config.ts`, `boot-config*.ts`, `cloud-only.ts`,
     `plugin-ui-spec.ts`, and `ui-spec.ts`.
   - Source: `phase-4-package-family-core.md`.

2. Move trigger DTOs to shared contracts.
   - Duplicates exist across agent, UI client types, and UI type shim.
   - Target: `packages/shared/src/contracts/triggers.ts` or equivalent.
   - Source: `phase-3-backend-types-routes-duplication.md`,
     `phase-4-package-family-core.md`.

3. Make conversation metadata schema canonical.
   - Shared Zod schema should export inferred types; replace agent/UI copies.
   - Source: `phase-3-backend-types-routes-duplication.md`.

4. Collapse LifeOps and Health contract stubs.
   - Replace `contract-stubs.ts` and `wave1-types.ts` imports with canonical
     public contracts.
   - Preserve AGENTS invariants: one `ScheduledTask`, health through registries,
     no LifeOps import of health internals, no behavior from prompt text.
   - Source: `phase-4-package-family-lifeops-apps.md`,
     `phase-4-shims-legacy-reexports-removal.md`.

5. Replace local-inference re-export shims.
   - UI and app-core local-inference shim files should import from
     `@elizaos/shared/local-inference/*` or a stable public owner.
   - Source: `phase-4-shims-legacy-reexports-removal.md`.

6. Move root test helper re-export stubs.
   - `test/helpers/http.ts`, `live-provider.ts`, `live-child-env.ts` re-export
     app-core test helpers and are widely used.
   - Either migrate imports to canonical app-core helpers or create a real
     test-support package.
   - Source: `phase-4-shims-legacy-reexports-removal.md`,
     `phase-4-package-family-examples-benchmarks-inference-cloud.md`.

## P1 - Suppression And Quality Cleanup

1. Burn down `@ts-nocheck` hotspots.
   - `plugins/plugin-wallet`: about 80 files.
   - `plugins/app-lifeops/src/lifeops/service-mixin-*.ts`: 28 files.
   - `plugins/plugin-local-ai`: 8 files; decide whether package is still live.
   - Source: `phase-4-ignores-suppressions-quality.md`,
     `phase-4-package-family-plugins.md`.

2. Replace actionable no-op catches.
   - Priority packages: plugin-sql, plugin-discord, plugin-openrouter,
     plugin-browser, plugin-capacitor-bridge, plugin-aosp-local-inference,
     agent API/runtime, app-core runtime, UI startup, cloud UI runtime.
   - Keep silent catches only through named quiet-cleanup helpers.
   - Source: `phase-4-ignores-suppressions-quality.md`.

3. Remove stale wave/TODO comments from source.
   - LifeOps action and scheduled-task comments, platform TODOs, app lifecycle
     TODOs, shared contract TODOs, agent permission TODOs, CI placeholder TODOs.
   - Source: `phase-4-ignores-suppressions-quality.md`.

4. Tighten broad Biome/ESLint disables.
   - Root `useHookAtTopLevel` disable, cloud broad rule downgrades, package
     `noExplicitAny: "off"` configs.
   - Source: `phase-4-ignores-suppressions-quality.md`.

## P2 - Markdown Cleanup

1. Delete ignored local markdown state.
   - `.claude/worktrees/`, training `.venv`, `.pytest_cache`, training
     `data/`, training `local-corpora/`.
   - Source: `phase-4-markdown-wipe-candidates.md`.

2. Delete generated prompt review pages.
   - `docs/audits/lifeops-2026-05-11/prompts/`.
   - Preserve any durable findings elsewhere first.
   - Source: `phase-4-markdown-wipe-candidates.md`.

3. Delete source-adjacent parameter rationale notes.
   - `plugins/app-lifeops/src/actions/*.params.notes.md`.
   - Source: `phase-4-markdown-wipe-candidates.md`.

4. Delete auto-generated PR resolver lesson file.
   - `.prr/lessons.md`; ignore `.prr/`.
   - Source: `phase-4-markdown-wipe-candidates.md`.

5. Delete generated benchmark result markdown.
   - `packages/benchmarks/benchmark_results/**`,
     `packages/benchmarks/configbench/results/*.md`,
     typo folder `benchmark_resukts`.
   - Source: `phase-4-markdown-wipe-candidates.md`.

6. Review before deleting older audits/docs.
   - Current cleanup folder stays until signoff.
   - Older `docs/audits/lifeops-*`, mobile audits, root release/status docs,
     inference status docs, top-level `reports/`, personality scenario
     distributions, cloud package docs, training package docs, plugin plans.
   - Keep README files, contributor/legal/security docs, docs-site content,
     skills docs, vendored inference fork docs, and GitHub templates unless
     owner approves.
   - Source: `phase-4-markdown-wipe-candidates.md`.

## P2 - Package Gate Standardization

Add package-local `build`, `typecheck`, `test`, and `lint` scripts or explicit
documented no-op scripts where root validation is the real owner.

Priority groups:

- Publishable app packages: many `plugins/app-*` packages lack `typecheck`,
  `test`, or `lint`.
- Provider/utility plugins: `plugin-wallet` lacks `typecheck`; several lack
  `test` or `lint`.
- Examples: most examples lack `test`; browser-extension has mutating `lint`.
- Native packages and private tool packages: several have no local gates.
- Cloud packages: some private cloud packages lack package-local build/test
  despite participating in the nested cloud workspace.

Source:
`phase-4-package-family-lifeops-apps.md`,
`phase-4-package-family-plugins.md`,
`phase-4-package-by-package-matrix.md`.

## P2 - Naming Cleanup

Do not rename public action IDs or provider exports blindly. First classify
whether each name is public behavior or just a transitional filename/class.

| Candidate | Action |
| --- | --- |
| `INBOX_UNIFIED` / `inbox-unified.ts` | Keep action ID unless planner/API alias strategy is approved. |
| `unified-wallet-provider.ts` | Rename only after product/API import scan. |
| `plugins/plugin-social-alpha` consolidated/backward-compatible services | Restore real typecheck first, then rename/remove old services. |
| UI `NewActionButton` and cloud `landing-page-new.tsx` | Rename only with UI owner/import scan. |

Source:
`phase-4-shims-legacy-reexports-removal.md`,
`phase-3-naming-shims-reexports.md`.

## P3 - Behaviorful Compat Or Stub Work

These are not zero-behavior deletes. They need product/API decisions or real
implementation.

- App-core `*-compat-routes.ts`.
- Plugin/cloud/steward compatibility routes.
- Workflow legacy migrations.
- Cloud frontend/API worker shims.
- Payment adapter stubs returning `stub.invalid`.
- RTMP relay stub sessions.
- Cloud MCP smoke harness.
- Plugin agent-orchestrator `sandbox-stub.ts`.
- Plugin music fallback utilities.
- Wallet browser shim.
- Plugin-discord compat types.

Source:
`phase-4-shims-legacy-reexports-removal.md`,
`phase-4-package-family-plugins.md`,
`phase-4-package-boundaries.md`.

## Swarm Implementation Order

1. Validation/tooling: Knip unblock, root test hang, preserve lint/typecheck/build.
2. No-reference deletes: one package at a time with exact grep and package tests.
3. Ignored/local artifact purge: clean local generated state only.
4. Tracked artifact split: reports, inference evidence, mobile bundles, benchmark
   data, training data.
5. Manifest graph: `fix-deps`, missing deps, duplicate package names.
6. Runtime boundaries: remove source reach-through imports and add a boundary
   audit gate.
7. Shared contracts: UI/shared config, SQL helpers, trigger DTOs, conversation
   metadata, local-inference shims.
8. LifeOps/Health contracts: collapse stubs while preserving AGENTS invariants.
9. Suppression burn-down: wallet, LifeOps mixins, local-ai, no-op catches.
10. Markdown/docs cleanup after durable facts are promoted.
11. Package gate standardization and export-map contraction.
12. Naming cleanup after public API decisions.

## Final Signoff Gate

Minimum required before marking the cleanup complete:

```sh
git status --short
git diff --check
bun run lint
bun run typecheck
bun run build
bun run test
bun run knip
node scripts/audit-package-barrels.mjs
bun run fix-deps:check
bunx madge --circular --extensions ts,tsx --exclude '(dist|build|node_modules|.turbo|coverage|.claude|packages/inference/llama.cpp|packages/app-core/platforms/electrobun/build)' packages plugins test
```

Known current blockers:

- `bun run test` root hang in app-core.
- `bun run knip` local oxc native binding signature failure.
