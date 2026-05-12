# Phase 4 JSON/Data/Generated Artifact Audit

Scope: `/Users/shawwalters/eliza-workspace/milady/eliza`

Date: 2026-05-11

Worker constraint: this report is inventory only. No files were deleted, renamed, or modified outside this report.

## Method

Commands used:

```sh
git status --short
git ls-files -- '*.json' '*.jsonl' '*.ndjson' '*.csv' '*.tsv' '*.parquet' '*.sqlite' '*.db' '*.bin' '*.gguf' '*.safetensors' '*.onnx' '*.pt' '*.pth' '*.npy' '*.npz' '*.zip' '*.tar' '*.tgz' '*.gz' '*.wasm' '*.dylib' '*.so' '*.a' '*.mp3' '*.wav' '*.mp4' '*.webm' '*.png' '*.jpg' '*.jpeg' '*.gif' '*.ico' '*.icns' '*.spv' '*.ptx' '*.pdf'
git ls-files reports artifacts benchmark_results packages/inference/reports packages/inference/verify packages/benchmarks plugins/app-training/datasets packages/app-core/test/contracts/lib/openzeppelin-contracts/fv/reports plugins/plugin-wallet/src/chains/evm/contracts/artifacts
git status --ignored --short packages/inference packages/benchmarks/benchmark_results artifacts benchmark_results reports
git check-ignore -v artifacts benchmark_results tmp packages/training/data/raw/opus-47-reachy-app-clem/.cache
du -sh reports artifacts benchmark_results packages/inference/reports packages/inference/verify/bench_results packages/inference/verify/hardware-results packages/benchmarks plugins/app-training/datasets packages/app-core/test/contracts/lib/openzeppelin-contracts/fv/reports plugins/plugin-wallet/src/chains/evm/contracts/artifacts packages/app-core/platforms/electrobun/build
rg -n 'packages/inference/reports|reports/local-e2e|verify/bench_results|hardware-results|android-vulkan-smoke' packages scripts .github docs --glob '!**/node_modules/**' --glob '!**/dist/**'
rg -n 'TimelockController\.json|VoteToken\.json|OZGovernor\.json|contracts/artifacts|from .*artifacts' plugins/plugin-wallet packages plugins test cloud --glob '!**/node_modules/**' --glob '!**/dist/**'
```

One broad ignored-file scan produced a very large result because `.claude/` worktrees and `tmp/` plugin staging copies mirror the repo. Those copies are ignored/local workspace state and should not affect source classification.

## Executive Findings

- Root `reports/` is tracked, large, and generated: `411` tracked files, `387M`. It contains QA screenshots, JSON summaries, porting logs, PTX/SPIR-V samples, audit outputs, and local validation logs. This should not live in the source tree.
- Root `artifacts/` is ignored and generated: `264M`. It contains Cerebras/action benchmark runs, local inference ablation output, updater screenshots, and logs. It is safe local cleanup material.
- Root `benchmark_results/` is ignored and generated: `120K`. It contains compaction/drift `.jsonl` runs. Safe local cleanup material.
- `packages/benchmarks/benchmark_results/` is ignored but present with many run groups, SQLite files, `viewer_data.json`, and `latest/*.json`. It should remain ignored and should be cleaned locally before packaging or archive creation.
- `packages/inference/reports/` is tracked and also has fresh untracked run output. Tracked count from this scan: `91` files (`70` JSON, `20` markdown, `1` script), size `1.2M`. It is a mixed folder: generated evidence plus a few active design/status docs.
- `packages/inference/verify/bench_results/` and `packages/inference/verify/hardware-results/` are tracked generated evidence folders. Counts: `47` tracked bench files and `18` tracked hardware result JSON files. New untracked files are also landing there.
- `packages/inference/verify/android-vulkan-smoke/` is tracked generated native output (`15` files including SPIR-V, object files, and an executable). It is a build artifact directory, not source.
- `packages/app-core/platforms/electrobun/build/` is ignored generated output, currently `122M`.
- `packages/inference/llama.cpp/build/` is a submodule-local ignored build tree, currently `154M`. It can be cleaned inside the submodule without source loss.
- `packages/benchmarks/` as a whole is `5.5G` and tracked. It contains real benchmark harness source plus large datasets/assets. Do not wipe wholesale; split source from datasets/output.
- `plugins/app-training/datasets/` has tracked training JSONL/data (`12` files, `6.9M`). It is likely training corpus material, not runtime source. Review ownership before deletion.

## High-Confidence Local Wipe Candidates

These are ignored or untracked generated outputs. They can be cleaned after a final dry run. They do not require source changes unless the team wants tighter ignores.

| Path | Status | Size/Count | Reason |
| --- | --- | ---: | --- |
| `artifacts/` | ignored | `264M` | Timestamped benchmark/action runs, logs, screenshots, local inference ablation output. Already ignored by `.gitignore:489`. |
| `benchmark_results/` | ignored | `120K` | Root compaction/drift `.jsonl` outputs. Already ignored by `.gitignore:460`. |
| `packages/benchmarks/benchmark_results/` | ignored | many run groups | Benchmark orchestrator output, SQLite/WAL files, viewer exports, `latest/*.json`; already ignored in `.gitignore`. |
| `tmp/` | ignored | large local state | Dev health checks, plugin staging, runtime imports, browser harness logs, local JSONL. Already ignored by `.gitignore:192`. |
| `.cache/`, `.pytest_cache/`, `coverage/`, `cache/`, `logs/` | ignored/local | varies | Test/cache/log output; already ignored globally. |
| `packages/app-core/platforms/electrobun/build/` | ignored | `122M` | Electrobun app bundle/build output. Already ignored by `.gitignore`. |
| `packages/app-core/platforms/electrobun/artifacts/` | ignored | varies | Packaged app artifacts. Already ignored by `.gitignore`. |
| `packages/app-core/platforms/android/**/build/` | ignored | varies | Gradle build intermediates. Already ignored by `.gitignore`. |
| `packages/app/android/`, `packages/app/ios/`, `packages/app/electrobun/` | ignored | varies | Generated app platform shells; canonical templates live under `packages/app-core/platforms`. |
| `packages/training/data/`, `packages/training/.venv/`, `packages/training/local-corpora/`, `packages/training/wandb/` | ignored by `packages/training/.gitignore` | potentially huge | Local datasets, Python env, raw corpora, experiment output. |
| `packages/inference/llama.cpp/build/` | submodule-local ignored | `154M` | Native llama.cpp build output. Clean inside the submodule. |

Suggested dry run:

```sh
git clean -ndX artifacts benchmark_results tmp .cache coverage cache logs packages/benchmarks/benchmark_results packages/app-core/platforms/electrobun/build packages/app-core/platforms/electrobun/artifacts packages/app-core/platforms/android
git -C packages/inference/llama.cpp clean -ndX build
```

## Fresh Untracked Generated Files

These are currently untracked and should not be added. They should either be deleted after review or covered by `.gitignore`.

```text
packages/inference/reports/bargein/bargein-latency-0_6b-refresh-20260512.json
packages/inference/reports/local-e2e/2026-05-11/asr-ffi-smoke-generated-tts-hello-20260512.json
packages/inference/reports/local-e2e/2026-05-11/asr-ffi-smoke-stablewav-20260512.json
packages/inference/reports/local-e2e/2026-05-11/e2e-loop-0_6b-20260512-example-1turn.json
packages/inference/reports/local-e2e/2026-05-11/eliza-1-0_6b-component-evidence-20260512.json
packages/inference/reports/vad/vad-from-generated-tts-0_6b-20260512.json
packages/inference/reports/vad/vad-quality-0_6b-refresh-20260512.json
packages/inference/verify/bench_results/embedding_0_6b_example_20260512.json
packages/inference/verify/hardware-results/dflash-drafter-runtime-example-20260512.json
```

Review before deleting:

```text
packages/inference/verify/vad_from_wav_example.mjs
```

Reason: the `.mjs` file may be a local one-off generated helper, but by extension and location it could also be intended source. It needs owner confirmation or an import/reference check before removal.

## Tracked Artifact Folders To Remove From Git

These are tracked today. Removing them is a repo cleanup change, not a local-only cleanup. The implementation should remove them from git, add ignore rules where missing, and fix or relocate references.

### `reports/`

Status: tracked, `411` files, `387M`.

Observed content:

- `reports/apps-manual-qa/**`: PNG screenshots, `report.json`, `issue-index.json`, screenshot lists.
- `reports/porting/**`: build logs, symbol dumps, PTX samples, SPIR-V blobs, JSON profiles, run notes.
- `reports/barrel-audit.*` and `reports/path-alias-audit.*`: generated audit output.

Recommendation: remove root `reports/` from git and add a root ignore for `reports/`. Keep durable decisions in `docs/audits/**` or package docs, not in timestamped report output. If any report is still needed as living documentation, promote only the distilled markdown into `docs/`.

Validation:

```sh
git ls-files 'reports/**' | wc -l
rg -n 'reports/' packages plugins cloud scripts docs .github --glob '!reports/**' --glob '!**/node_modules/**' --glob '!**/dist/**'
git rm -r reports
```

### `packages/inference/reports/`

Status: tracked, `91` files, `1.2M`, plus fresh untracked run output.

This folder is mixed:

- Generated evidence: local E2E JSON, gate reports, ASR/TTS/VAD reports, hardware logs, performance JSON.
- Active markdown/design notes referenced by code and docs, for example `wakeword-head-plan.md` and `qwen-backbone-unification.md`.
- One helper script under a report date folder: `packages/inference/reports/porting/2026-05-11/render-ios-smoke-report.mjs`.

Recommendation: split it.

- Move durable inference design/status docs to `packages/inference/docs/` or `docs/inference/`.
- Move scripts to `packages/inference/scripts/` or `packages/inference/verify/`.
- Delete generated JSON/log/audio/evidence output from git.
- Add ignore rules for generated output directories.

Do not blindly delete the entire tree until durable docs/scripts are moved. Current inbound references include `packages/app-core/src/services/local-inference/voice/wake-word.ts`, `packages/shared/src/local-inference/catalog.ts`, `packages/app-core/src/services/local-inference/manifest/schema.ts`, and several training/manifest scripts.

### `packages/inference/verify/bench_results/`

Status: tracked, `47` files (`41` JSON, `6` SPIR-V).

Reason to remove: these are benchmark result artifacts. Several scripts explicitly write output here, including `asr_bench.ts` and cloud hardware runners. Keeping checked-in current results makes every local verification run create source churn.

Review caveat: some manifest and report scripts reference specific evidence file names. Replace those references with generated-artifact expectations, an external artifact URL, or a documented command.

### `packages/inference/verify/hardware-results/`

Status: tracked, `18` JSON files, plus fresh untracked output.

Reason to remove: hardware verification evidence is generated per machine/GPU/device. This should be stored in CI artifacts or release evidence, not committed as mutable repo state.

Review caveat: docs such as `packages/inference/verify/HARDWARE_VERIFICATION.md` intentionally describe this directory as a write target. Keep that docs pattern, but ignore the generated contents.

### `packages/inference/verify/android-vulkan-smoke/`

Status: tracked, `15` files including generated SPIR-V, object files, and an executable.

Reason to remove: `android_vulkan_smoke.sh` uses this as an output folder (`ELIZA_ANDROID_VULKAN_OUT_DIR`, default `android-vulkan-smoke`). Build outputs should be regenerated by `make -C packages/inference/verify android-vulkan-smoke`.

Suggested action: remove from git and ignore `packages/inference/verify/android-vulkan-smoke/`.

### `packages/agent/dist-mobile-ios/` and `packages/agent/dist-mobile-ios-jsc/`

Status: tracked generated mobile bundles, `11` files total (`4` wasm, `3` JSON, `2` JS, `2` data).

Reason to remove: current `.gitignore` already calls out generated mobile bundle outputs under `packages/agent/dist-mobile/`, but the iOS-specific variants are still tracked. These are generated bundle outputs, not source.

Review caveat: confirm no release pipeline depends on checked-in iOS bundle snapshots. If a release needs deterministic fixtures, replace with a minimal fixture or generate in CI.

### `packages/app-core/test/contracts/lib/openzeppelin-contracts/fv/reports/*.pdf`

Status: tracked, `3` PDFs, `420K`.

Reason to remove: vendored audit PDFs are not test input. The only hits found were links from `packages/app-core/test/contracts/lib/openzeppelin-contracts/audits/README.md`.

Recommended action: if keeping the vendored README, replace links with upstream URLs or remove the audit docs from the test fixture. Do not keep binary PDFs in test fixtures.

### `plugins/plugin-wallet/src/chains/evm/contracts/artifacts/*.json`

Status: tracked, `3` generated contract artifacts.

Reference check:

- `plugins/plugin-wallet/src/chains/evm/gov-router.ts` imports `./contracts/artifacts/OZGovernor.json`.
- No source reference was found for `TimelockController.json` or `VoteToken.json` in the scoped search.

Recommendation:

- Do not delete `OZGovernor.json` until `gov-router.ts` is refactored to import a stable ABI/source file or a typed generated artifact committed under a source-owned name.
- `TimelockController.json` and `VoteToken.json` are high-confidence generated/unreferenced artifacts, but should be removed together with a contract build workflow check.

## Review-Needed Large Data Areas

### `packages/benchmarks/`

Status: tracked, `5.5G`, `3077` files in this scan.

Composition includes benchmark harness source plus large fixtures/datasets/assets:

- `packages/benchmarks/OSWorld/**`: many JSON examples and PNG/JPG assets.
- `packages/benchmarks/HyperliquidBench/**`: dataset, frontend assets, Rust/Python harness.
- benchmark-specific fixture trees under `gaia`, `loca-bench`, `webshop`, `terminal-bench`, etc.

Do not wipe the package wholesale. Recommended cleanup is a package boundary split:

- Keep harness source, registry metadata, tests, and small deterministic fixtures.
- Move large upstream benchmark datasets/assets into external downloads, Git LFS, artifact storage, or a separate submodule.
- Add bootstrap scripts that verify checksums and fetch data on demand.
- Keep `packages/benchmarks/benchmark_results/` ignored and out of git.

### `plugins/app-training/datasets/`

Status: tracked, `12` files, `6.9M`.

Observed files are JSONL training corpora and metadata. They look generated or derived:

- `lifeops_action_planner_from_benchmark.jsonl`
- `lifeops_corrected_balanced10.jsonl`
- `lifeops_full_mixed_action_planner.jsonl`
- `lifeops_mixed_action_planner.jsonl`
- `lifeops_anthropic_action_planner.jsonl`
- `lifeops_balanced_action_planner.jsonl`
- additional small/balanced/corrected variants and metadata.

Recommendation: owner review. If these are release inputs, move them to an explicit data package with provenance and checksum. If they are training scratch/output, delete from git and ignore `plugins/app-training/datasets/*.jsonl`.

### `packages/inference/llama.cpp/models/`

Status: tracked inside the `packages/inference/llama.cpp` submodule, `54M`.

These are llama.cpp vocabulary/template fixtures, not local generated model weights. Keep unless the submodule itself is being cleaned upstream. Root `.gitignore` already ignores `*.gguf` for the superproject, but submodule policy controls these files.

## Keep: JSON/Data That Is Source

Do not wipe these classes just because they are JSON:

- `package.json`, `tsconfig*.json`, `biome.json`, `knip.json`, `turbo.json`, workspace/package manifests.
- `cloud/packages/db/migrations/meta/*.json` and `_journal.json`; migration metadata is source.
- `packages/app-core/src/registry/entries/**/*.json`; registry entries are source data.
- `packages/app-core/src/services/local-inference/manifest/*.json`; release/runtime manifest source.
- `cloud/services/vast-pyworker/manifests/*.json`; worker model manifests.
- `test/mocks/environments/*.json` and `test/mocks/mockoon/*.json`; test fixtures.
- `scripts/benchmark/configs/*.json`; benchmark configuration source, not output.
- platform asset catalogs such as `Assets.xcassets/**/Contents.json`; app packaging source.
- `packages/inference/llama.cpp/models/templates/*.jinja` and vocab test fixtures inside the submodule.

## Proposed Ignore Changes

Existing ignore rules already cover `artifacts/`, `benchmark_results/`, root/local `tmp/`, `logs/`, `coverage`, `dist`, generated app platform shells, Electrobun build output, Android build output, archives, model/audio extensions, and `packages/training/data/`.

Missing or incomplete rules to add:

```gitignore
# Generated report/evidence output
reports/
packages/inference/reports/
packages/inference/verify/bench_results/
packages/inference/verify/hardware-results/
packages/inference/verify/android-vulkan-smoke/

# Generated mobile bundles
packages/agent/dist-mobile-ios/
packages/agent/dist-mobile-ios-jsc/

# Optional: generated training corpora, if owner confirms these are reproducible
plugins/app-training/datasets/*.jsonl
plugins/app-training/datasets/*.meta.json
```

If durable inference docs are moved out of `packages/inference/reports/`, add those ignore rules after the move. Until then, ignoring the whole folder may hide accidental source edits in the mixed report/doc tree.

## Cleanup Implementation Order

1. Add ignore rules for generated report/evidence folders and iOS mobile bundle outputs.
2. Locally clean ignored output with `git clean -ndX`, review, then `git clean -fdX` only for approved paths.
3. Split `packages/inference/reports/`: move durable docs/scripts to a source-owned docs/scripts location, then remove generated output from git.
4. Remove tracked `reports/` from git after promoting any durable findings to `docs/audits/**`.
5. Remove tracked inference bench/hardware/android-vulkan generated output and update docs/scripts to write there without expecting checked-in files.
6. Remove generated mobile bundle outputs from `packages/agent/dist-mobile-ios*` after release pipeline confirmation.
7. Refactor `plugins/plugin-wallet` ABI usage, then remove unneeded generated contract artifacts.
8. Decide whether `plugins/app-training/datasets/` is source, release data, or generated scratch. Move or ignore accordingly.
9. Plan a separate benchmark package data split for `packages/benchmarks/` because it mixes source harnesses with large datasets/assets.

## Validation Commands

Inventory before and after:

```sh
git status --short
git status --ignored --short artifacts benchmark_results reports packages/inference packages/benchmarks/benchmark_results packages/agent
git ls-files 'reports/**' 'packages/inference/reports/**' 'packages/inference/verify/bench_results/**' 'packages/inference/verify/hardware-results/**' 'packages/inference/verify/android-vulkan-smoke/**' 'packages/agent/dist-mobile-ios/**' 'packages/agent/dist-mobile-ios-jsc/**'
git check-ignore -v reports packages/inference/reports packages/inference/verify/bench_results packages/inference/verify/hardware-results packages/inference/verify/android-vulkan-smoke packages/agent/dist-mobile-ios packages/agent/dist-mobile-ios-jsc
```

Dry-run local cleanup:

```sh
git clean -ndX artifacts benchmark_results tmp .cache coverage cache logs packages/benchmarks/benchmark_results packages/app-core/platforms/electrobun/build packages/app-core/platforms/electrobun/artifacts packages/app-core/platforms/android
git -C packages/inference/llama.cpp clean -ndX build
```

Reference checks before tracked removal:

```sh
rg -n 'reports/|packages/inference/reports|verify/bench_results|hardware-results|android-vulkan-smoke|dist-mobile-ios|contracts/artifacts' packages plugins cloud scripts docs .github --glob '!**/node_modules/**' --glob '!**/dist/**'
rg -n 'TimelockController\.json|VoteToken\.json|OZGovernor\.json' plugins/plugin-wallet packages test --glob '!**/node_modules/**' --glob '!**/dist/**'
```

Repo validation after cleanup:

```sh
bun run lint
bun run typecheck
bun run build
bun run test
bunx madge --circular --extensions ts,tsx --exclude '(dist|build|node_modules|.turbo|coverage|.claude|packages/inference/llama.cpp|packages/app-core/platforms/electrobun/build)' packages plugins test
bun run knip
git diff --check
```

Known caveat from the broader cleanup run: `bun run knip` may be blocked locally by the `@oxc-resolver/binding-darwin-arm64` native code-signing issue. If that persists, run Knip in CI or a clean Node/Bun install and record the environment.

