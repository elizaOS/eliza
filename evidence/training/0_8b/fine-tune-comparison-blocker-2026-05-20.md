# Eliza-1 0_8b Fine-Tune Comparison Blocker - 2026-05-20

Status: blocked.

The current repo and Hugging Face release surface do not contain enough
artifacts to produce an honest active `0_8b` base-vs-finetuned comparison.

Observed on Hugging Face:

- Present: `evidence/training/fine-tune-comparison.json`
- Missing: `bundles/0_8b/finetuned-v2/eliza-1-0_8b-sft.gguf`
- Missing: `evidence/training/0_8b/eliza-bench.json`
- Missing: `evidence/training/0_8b/native-tool-call.json`
- Missing: `evidence/training/0_8b/structured-response.json`
- No entries exist under `bundles/0_8b/finetuned-v2/`

The active dataset package is present and validates:

- `elizaos/eliza-1-training/sft/0_8b/manifest.json`
- `elizaos/eliza-1-training/sft/0_8b/validation.json`
- Counts: train 116, val 6, test 3, total 125

Local execution is not feasible on this host. This machine is macOS arm64
with no CUDA stack, no local Torch install, and no Triton install. The active
APOLLO fine-tune path must run in the Linux/CUDA training image or a cloud
target.

The release audit still reports:

`fineTuneComparison`: `status: 'blocked', legacy 0_6b comparison evidence is
not current release evidence, comparisons.0_8b: missing`.

Next steps:

1. Export `HF_TOKEN` with the operator-supplied split-token construction,
   without printing it.
2. Download `elizaos/eliza-1-training/sft/0_8b/*`.
3. Run the `qwen3.5-0.8b` smoke and preflight in Linux/CUDA and preserve
   smoke plus `.preflight.ok` evidence.
4. Run `scripts/run_pipeline.py --registry-key qwen3.5-0.8b` with the active
   `sft/0_8b` train/val/test files and run name `eliza-1-0_8b-finetuned-v2`.
5. Publish `bundles/0_8b/finetuned-v2/eliza-1-0_8b-sft.gguf` with provenance.
6. Run and publish baseline-vs-finetuned `eliza_bench`, `native_tool_call`,
   and `structured_response` reports.
7. Mark `evidence/training/fine-tune-comparison.json` as pass only when
   `comparisons.0_8b.passed=true` and `comparisons.0_8b.beatsBaseline=true`.
