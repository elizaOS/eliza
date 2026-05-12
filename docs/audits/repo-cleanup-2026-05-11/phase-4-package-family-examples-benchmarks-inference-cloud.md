# Phase 4 - Examples, Benchmarks, Inference, Training, And Cloud-Adjacent Audit

Workspace: `/Users/shawwalters/eliza-workspace/eliza/eliza`
Mode: dry run / report only

No source files were deleted or modified for this pass.

## Scope

`packages/examples`, `packages/inference`, `packages/benchmarks`,
`packages/training`, `plugins/app-training`, `scripts`, `test`, and
cloud-adjacent generated/report surfaces that showed up in artifact scans.

## Methodology

Read-only commands used:

```sh
git ls-files 'packages/examples/**' 'packages/inference/**' 'packages/benchmarks/**' 'packages/server/**' 'packages/client-direct/**' 'scripts/**' 'test/**' |
  rg -n -i '(report|reports|bench|benchmark|dataset|training|fixture|fixtures|generated|latest|artifact|legacy|deprecated|fallback|stub|shim|compat|unified|consolidated|TODO|FIXME|HACK|@ts-nocheck|eslint-disable|biome-ignore|\.json$|\.jsonl$|\.md$)'
git ls-files packages/inference/reports packages/inference/verify/bench_results packages/inference/verify/hardware-results packages/inference/verify/android-vulkan-smoke
git ls-files packages/benchmarks/benchmark_results/latest packages/benchmarks/OSWorld/evaluation_examples packages/benchmarks/HyperliquidBench/dataset packages/training/scripts/harness/scenario_pool plugins/app-training/datasets
git ls-files -o --exclude-standard | rg -n -i '(report|benchmark|generated|artifact|e2e|\.json$)'
du -sh packages/inference/reports packages/inference/verify/bench_results packages/inference/verify/hardware-results packages/inference/verify/android-vulkan-smoke
```

## High-Confidence Artifact Cleanup

### EBI-01 - Untracked Inference Run Reports

Current untracked files:

- `packages/inference/reports/bargein/bargein-latency-0_6b-refresh-20260512.json`
- `packages/inference/reports/local-e2e/2026-05-11/asr-ffi-smoke-generated-tts-hello-20260512.json`
- `packages/inference/reports/local-e2e/2026-05-11/asr-ffi-smoke-stablewav-20260512.json`
- `packages/inference/reports/local-e2e/2026-05-11/e2e-loop-0_6b-20260512-example-1turn.json`
- `packages/inference/reports/vad/vad-from-generated-tts-0_6b-20260512.json`
- `packages/inference/reports/vad/vad-quality-0_6b-refresh-20260512.json`
- `packages/inference/verify/bench_results/embedding_0_6b_example_20260512.json`
- `packages/inference/verify/hardware-results/dflash-drafter-runtime-example-20260512.json`

Recommendation:
delete untracked local reports and ensure the containing patterns remain
ignored. These are local run outputs, not source.

Dry-run:

```sh
git clean -n -- packages/inference/reports packages/inference/verify/bench_results packages/inference/verify/hardware-results
```

Validation:
none beyond `git status --short`; deleting untracked reports does not affect
build output.

### EBI-02 - Tracked Inference Result Folders

Tracked result count and size:

- `packages/inference/reports`: tracked and untracked reports, currently about
  1.2 MiB on disk.
- `packages/inference/verify/bench_results`: about 360 KiB.
- `packages/inference/verify/hardware-results`: about 260 KiB.
- `packages/inference/verify/android-vulkan-smoke`: about 5.5 MiB and contains
  fixture/result material.
- `git ls-files` finds 171 tracked files across those inference result groups.

Recommendation:
split fixture inputs from run outputs. Keep small deterministic fixtures under
`verify/fixtures` or `verify/android-vulkan-smoke/fixtures`; move dated
hardware, bench, local-e2e, VAD, and barge-in reports out of source control.

Dry-run:

```sh
git rm -r -n -- packages/inference/reports packages/inference/verify/bench_results packages/inference/verify/hardware-results
```

Risk:
Medium. Some reports are evidence for current kernel work. Convert any required
evidence into one curated markdown or fixture before deleting dated outputs.

### EBI-03 - Tracked Mobile Agent Bundles

Paths:

- `packages/agent/dist-mobile-ios/`
- `packages/agent/dist-mobile-ios-jsc/`

Evidence:
11 tracked files, around 93 MiB on disk, including JS bundles, WASM, data, and
plugin manifests. `packages/agent/scripts/build-mobile-bundle.mjs` owns
regeneration.

Recommendation:
stop tracking generated mobile bundles once the consuming mobile build runs the
bundle generation step first.

Dry-run:

```sh
git rm -r -n -- packages/agent/dist-mobile-ios packages/agent/dist-mobile-ios-jsc
```

Validation:

```sh
bun run --cwd packages/agent build:ios-bun
bun run --cwd packages/agent build:ios-jsc
node packages/app-core/scripts/run-mobile-build.mjs ios
```

Risk:
High until mobile staging is changed. Do not delete before build pipeline
change.

## Benchmark, Dataset, And Training Bulk

Tracked data-heavy groups:

- `packages/benchmarks/OSWorld/evaluation_examples/**`
- `packages/benchmarks/HyperliquidBench/dataset/**`
- `packages/benchmarks/benchmark_results/latest/**`
- `packages/training/scripts/harness/scenario_pool/*.jsonl`
- `plugins/app-training/datasets/*.jsonl`

Current scan found 693 tracked files across those benchmark/training groups.

Recommendation:
separate three categories:

1. Source fixtures required for tests: keep, but name them `fixtures` and keep
   them small.
2. Benchmark datasets vendored from upstream: move to submodule, release
   artifact, or download step.
3. Generated benchmark/training outputs: delete from git and ignore.

Dry-run:

```sh
git rm -r -n -- packages/benchmarks/benchmark_results/latest plugins/app-training/datasets
```

Risk:
Medium to high. Benchmarks may intentionally vendor upstream datasets. The
cleanup should not delete benchmark source without replacing acquisition docs.

## Example Package Issues

`packages/examples/browser-extension/package.json` currently has:

- `build` as an informational skip.
- `typecheck` as `echo 'No TypeScript config; skipping typecheck'`.
- `lint` runs Biome with `--write --unsafe`, which mutates during lint.

TODO:

1. Split mutating lint into `lint:fix`; make `lint` read-only.
2. Add a real package typecheck or remove the example from required typecheck
   orchestration with an explicit reason.
3. Ensure Safari/Chrome generated build outputs stay ignored and source assets
   are intentional.

## Scripts And Test Helper Shims

Root `test/helpers/http.ts`, `test/helpers/live-provider.ts`, and
`test/helpers/live-child-env.ts` are re-export stubs pointing into
`packages/app-core/test/helpers`. They are actively imported by app/plugin live
tests, so deletion requires import migration first.

Recommended dry-run sequence:

```sh
rg -n 'test/helpers/(http|live-provider|live-child-env)' packages plugins test
```

Then replace imports with the canonical app-core helper path or introduce a
dedicated test-support package. Delete the root re-export stubs after grep hits
zero.

## Cloud-Adjacent Notes

Cloud compatibility routes and generated router files are not no-behavior
deletions. `cloud/apps/api/src/_router.generated.ts` is generated but imported
by cloud API bootstrap. Delete only if codegen runs before cloud build and the
generated output is ignored or emitted into build output.

## Validation Gate

After approved cleanup in this family:

```sh
git status --short
bun run test:launch-qa
bun run --cwd packages/inference verify:contract
bun run --cwd packages/agent build:ios-bun
bun run --cwd packages/agent build:ios-jsc
bun run lint
bun run typecheck
bun run build
```

Root `bun run test` currently hangs in the app-core phase after earlier passing
cloud SDK/agent tests. Keep that blocker separate from artifact cleanup unless
the implementation touches app-core test orchestration.
