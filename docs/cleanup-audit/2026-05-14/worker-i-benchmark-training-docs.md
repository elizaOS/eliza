# Worker I Benchmark, Training, Docs Cleanup

Scope: `packages/benchmarks/**`, `packages/training/**`, `packages/docs/**`, and cleanup audit reports. I did not edit examples, homepage, or plugins.

## Code Changes

- `packages/benchmarks/solana/solana-gym-env/docs/trajectory-viewer/package.json`
  - Removed unused `react-markdown`.
- `packages/benchmarks/solana/solana-gym-env/docs/trajectory-viewer/bun.lock`
  - Regenerated after removing `react-markdown`.
- `packages/benchmarks/solana/solana-gym-env/docs/trajectory-viewer/src/App.tsx`
  - Demoted `MessageData` from exported type to internal type.
  - Removed stale explanatory comments on already-obvious fields.
- `packages/benchmarks/solana/solana-gym-env/docs/trajectory-viewer/vite.config.ts`
  - Removed the manual markdown chunk group after deleting the markdown renderer dependency.
- `knip.json`
  - Added a workspace entry for `trajectory-viewer` so Knip sees `vite.config.ts` as an entry instead of reporting it and `@vitejs/plugin-react` as unused.
- `packages/training/local-corpora/scambench-github/src/scenario-data.ts`
  - Fixed builder input types so scenario `preamble` data is accepted instead of rejected by helper signatures.
- `packages/training/local-corpora/scambench-github/src/types.ts`
  - Added `system` to `ScamBenchChannel` because system preamble messages already exist in the corpus.
- `packages/training/local-corpora/scambench-github/src/model-handler.ts`
  - Removed mutation of endpoint config during unsupported `tools`/JSON retries.
  - Passed target mode explicitly to request construction so fallback retries disable optional API features without rewriting caller config.
- `packages/training/local-corpora/scambench-github/src/live-attack-scenarios.ts`
  - Replaced `as any` casts with real `SafeAction` and `ScamBenchChannel` types.
  - Fixed live stage construction to populate required `label`.
- `packages/training/local-corpora/scambench-github/src/verifiable-scorer.ts`
  - Typed alignment checks against `ScamBenchStageDecision["chosenAction"]`.
  - Removed the `as any` engagement check.

## Generated Files Removed

- Removed generated `dist/` and `.turbo/` output from `packages/benchmarks/solana/solana-gym-env/docs/trajectory-viewer/`.
- Removed untracked `.DS_Store` files found under `packages/benchmarks/` and `packages/training/`.
- Removed `packages/benchmarks/solana/solana-gym-env/voyager/skill_runner/tsconfig.tsbuildinfo`.

## Validation

- PASS: `node scripts/knip-workspaces.mjs --filter trajectory-viewer --fail-on-issues --fail-fast`
- PASS: `node scripts/knip-workspaces.mjs --filter packages/docs --fail-on-issues --fail-fast`
- PASS: `node scripts/knip-workspaces.mjs --filter packages/benchmarks --fail-on-issues --fail-fast`
- PASS: `/Users/shawwalters/.bun/bin/bun run --cwd packages/benchmarks/solana/solana-gym-env/docs/trajectory-viewer typecheck`
- PASS: `/Users/shawwalters/.bun/bin/bun run --cwd packages/benchmarks/solana/solana-gym-env/docs/trajectory-viewer build`
- PASS: `/Users/shawwalters/.bun/bin/bun run --cwd packages/benchmarks/eliza-1 typecheck`
- PASS: `/Users/shawwalters/.bun/bin/bun run --cwd packages/benchmarks/interrupt-bench typecheck`
- PASS: `/Users/shawwalters/.bun/bin/bun run --cwd packages/benchmarks/lib typecheck`
- PASS: `/Users/shawwalters/.bun/bin/bun run --cwd packages/benchmarks/eliza-1 test` - 25 tests passed.
- PASS: `/Users/shawwalters/.bun/bin/bun run --cwd packages/benchmarks/interrupt-bench test` - 24 tests passed.
- PASS: `/Users/shawwalters/.bun/bin/bun run --cwd packages/docs test` - 11 tests passed.
- PASS: `/Users/shawwalters/.bun/bin/bun run --cwd packages/training/local-corpora/scambench-github typecheck`
- PASS: `/Users/shawwalters/.bun/bin/bun run --cwd packages/training/local-corpora/scambench-github test` - 197 tests passed.
- PASS: `git diff --check -- knip.json packages/benchmarks/solana/solana-gym-env/docs/trajectory-viewer packages/training/local-corpora/scambench-github`

## Artifact Inventory

Large ignored/untracked directories:

- `packages/training/data/raw` - 127G, ignored by `packages/training/.gitignore`.
- `packages/training/local-corpora` - 2.0G, ignored by `packages/training/.gitignore`.
- `packages/training/.venv` - 866M, ignored.
- `packages/benchmarks/benchmark_results` - 83M, ignored.
- `packages/benchmarks/HyperliquidBench/target` - 1.7G, ignored by package `.gitignore`.
- `packages/benchmarks/configbench/node_modules` and `packages/benchmarks/evm/skill_runner/node_modules` are package-local ignored installs.

Tracked scope inventory:

- `packages/benchmarks`, `packages/training`, and `packages/docs` contain 16,101 tracked benchmark files, 380 tracked docs files, and 0 tracked files under `packages/training/data/raw` or `packages/training/local-corpora`.
- Tracked file-type hotspots in scope include 4,414 `.py`, 2,526 `.json`, 1,757 `.sh`, 1,383 `.md`, 328 `.jsonl`, 144 `.png`, 68 `.mdx`, 66 `.jpg`, 38 `.pdf`, 8 `.xlsx`, 5 `.mp4`, 4 `.docx`, 3 `.pt`, and 3 `.pptx`.

Large tracked artifact candidates:

- `packages/benchmarks/skillsbench/tasks/organize-messy-files/environment/DAMOP.pptx` - 35M.
- `packages/benchmarks/skillsbench/tasks/dapt-intrusion-detection/environment/packets.pcap` - 31M.
- Treasury Bulletin PDFs under `packages/benchmarks/claw-eval/tasks/T076-T085*/fixtures/pdf/` - multiple 15M to 29M files.
- `packages/benchmarks/openclaw-benchmark/autonomous_agent_env/shellcheck-v0.10.0/shellcheck` - 15M executable.
- `packages/benchmarks/swe-bench-pro/helper_code/sweap_eval_full_v2.jsonl` - 24M.
- `packages/benchmarks/terminal-bench/tasks/pytorch-model-recovery/*.pt` - tracked PyTorch weights.
- `packages/benchmarks/skillsbench/docs/skills-research/*.json` - generated research/index JSON around 1.1M to 1.7M each.
- `packages/training/data/final-eliza1-smoke/*.jsonl` and `packages/training/datasets/eliza1-sft-0_6b/*.jsonl` are tracked dataset slices, much smaller than raw corpora but still review-worthy.

## Wipe/Ignore Candidates

Safe ignored cleanup:

- Periodically delete ignored `packages/training/data/raw`, `packages/training/local-corpora`, `.venv`, `node_modules`, `benchmark_results`, `target`, `dist`, `.turbo`, `*.tsbuildinfo`, and `.DS_Store` outputs before final signoff.

Needs owner decision before deletion:

- Benchmark fixture binaries and documents under `skillsbench`, `claw-eval`, `terminal-bench`, and `OSWorld`. These appear to be real task fixtures, so deleting them would change benchmark coverage.
- Generated benchmark research JSON under `packages/benchmarks/skillsbench/docs/skills-research/`. These are likely rebuildable and should either move to generated artifacts or be documented as canonical fixtures.
- SWE Bench Pro trajectory/eval JSON under `packages/benchmarks/swe-bench-pro/traj/**`. These look like generated run outputs and should be moved out of tracked source if not canonical.
- Training smoke and SFT JSONL slices under `packages/training/data/final-eliza1-smoke/` and `packages/training/datasets/eliza1-sft-0_6b/`. They are tracked and small enough to keep, but should be explicitly classified as fixtures.

Markdown cleanup candidates:

- There are 1,451 tracked Markdown/MDX files in this scope. Most are benchmark/task READMEs or docs-site content and should not be wiped blindly.
- Higher-priority review targets are planning/status files, especially `packages/benchmarks/HyperliquidBench/docs/PLAN_*.md`, `packages/benchmarks/HyperliquidBench/docs/TODO_PLAN_MASTER.md`, and generated summaries under benchmark tool subtrees.

Lockfile cleanup candidates:

- Root package management is Bun, but benchmark fixture subprojects intentionally include `package-lock.json`, `uv.lock`, `Cargo.lock`, `flake.lock`, and nested `bun.lock` files. Keep only lockfiles needed for reproducible benchmark fixtures; generated build locks under ignored `target/` should stay untracked.

## Remaining Risk

- I did not delete tracked benchmark fixtures because many are the input data for benchmark tasks. Those should be reviewed per benchmark suite with task owners.
- `packages/training/local-corpora/scambench-github` is under an ignored parent directory, so the type fixes are local workspace changes unless that corpus is intentionally promoted into tracked source.
