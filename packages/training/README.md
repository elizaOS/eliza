# eliza-1 — Training Pipeline

Fine-tunes the **eliza-1** model series (`eliza-1-0_8b`, `eliza-1-2b`,
`eliza-1-4b`) on Eliza-native Vercel AI SDK trajectory rows: the exact
request sent to the model plus the exact normalized response returned by the
model, including native tool calls.

> **This directory is gitignored.** The canonical artifact stores live on
> HuggingFace, not in git history:
>
> | what                              | repo                                      | script                          |
> |-----------------------------------|-------------------------------------------|---------------------------------|
> | Dataset (native trajectory SFT)   | runtime `eliza_native_v1` exports          | `scripts/trajectories_to_sft.py`|
> | Trained models                    | `elizaos/eliza-1` (model; `bundles/<tier>/`) | `scripts/push_model_to_hf.py`   |
> | Pipeline source (this directory)  | `elizaos/eliza-1-pipeline` (model) | `scripts/push_pipeline_to_hf.py`|
>
> Quants land under the same `elizaos/eliza-1` model repo alongside each
> bundle manifest; do not create per-quant public defaults.

The base models are catalogued in `scripts/training/model_registry.py`;
each entry is tagged `local | workstation | cloud`. Default optimizer is
**APOLLO** (full-parameter SFT, low-memory projected optimizer state,
arXiv:2412.05270), not LoRA.

| registry key | eliza release | base               | tier        | default training target             | optimizer    |
|--------------|---------------|--------------------|-------------|-------------------------------------|--------------|
| qwen3.5-0.8b | eliza-1-0_8b  | Qwen/Qwen3.5-0.8B  | local       | 16 GB consumer GPU                  | apollo_mini  |
| qwen3.5-2b   | eliza-1-2b    | Qwen/Qwen3.5-2B    | local       | 16 GB consumer GPU                  | apollo_mini  |
| qwen3.5-4b   | eliza-1-4b    | Qwen/Qwen3.5-4B    | local       | 24 GB consumer/workstation GPU      | apollo_mini  |

After training, two **post-training quantization** passes run:
**PolarQuant** (4-bit weights via Hadamard rotation, arXiv:2603.29078) and
**TurboQuant** (online KV-cache quantization, arXiv:2504.19874). KV
compression is rounded out by **QJL** (1-bit JL-projected K cache,
arXiv:2406.03482).

A unified pipeline runner (`scripts/run_pipeline.py`) chains:

  base bench → APOLLO SFT → fine-tuned bench → PolarQuant + TurboQuant + QJL → quantized bench

Per-task benchmarks live in `scripts/benchmark/native_tool_call_bench.py` and
score native tool-call structure, tool names, argument keys, and JSON routing
shape on the held-out trajectory split.

## Cloning the pipeline on a fresh machine

```bash
hf download elizaos/eliza-1-pipeline --repo-type model --local-dir ./training
cd training
uv sync --extra train
```

## Pipeline

```
datasets.yaml ──▶ download_datasets.py ──▶ data/raw/<slug>/
prompts/    ──▶ extract_eliza_prompts.py ──▶ data/prompts/registry.json
                                                  │
                                                  ▼
                          synthesize_targets.py (teacher: Anthropic API)
                                                  │
                                                  ▼
data/raw/* ──▶ normalize.py ──▶ data/normalized/<slug>.jsonl
                                  │
                                  ▼
                            pack_dataset.py
                                  │
                                  ▼
                  data/final/{train,val,test}.jsonl
                                  │
                       ┌──────────┴──────────┐
                       ▼                     ▼
              train_local.py        train_vast.sh
              (APOLLO, 0.8B/2B)     (APOLLO, 4B remote GPU)
                                  │
                                  ▼
              ┌─────────────┬─────┴─────┬─────────────┐
              ▼             ▼           ▼             ▼
       polarquant_apply  turboquant_apply  qjl_apply (vendored)
                                  │
                                  ▼
                          native_tool_call_bench.py
                  (native tool-call + JSON structure correctness)
```

## Native Tool-Calling Data

The runtime training path uses native JSON records, not alternate harness rows.
The contract is documented in
[`docs/dataset/NATIVE_TOOL_CALLING_SPEC.md`](docs/dataset/NATIVE_TOOL_CALLING_SPEC.md).
Source transform families are summarized in
[`docs/dataset/NATIVE_SOURCE_TRANSFORMS.md`](docs/dataset/NATIVE_SOURCE_TRANSFORMS.md).

Bootstrap flow:

```bash
uv run python scripts/download_datasets.py --priority all \
    --skip nubilio-trajectories,light-multilight \
    --max-workers 2 --min-free-gb 40
uv run python scripts/normalize.py
uv run python scripts/prepare_native_tool_calling_data.py --write-matrix
uv run python scripts/prepare_native_tool_calling_data.py \
    --transform-normalized --validate-native
uv run python scripts/bootstrap_native_to_eliza_native.py \
    --input data/native/records \
    --output data/native/eliza_native_bootstrap.jsonl
```

The source matrix is written to `data/native/source_matrix.json` and
`data/native/SOURCE_MATRIX.md`. It records every datasource's transform family,
strengths, weaknesses, raw-data status, and recommended native-training weight.
`bootstrap_native_to_eliza_native.py` converts bootstrap rows into the same
`eliza_native_v1` request/response boundary format used by real runtime
trajectory exports.

Trajectory alignment audit:

```bash
uv run --with pyyaml --with pyarrow \
    python scripts/sample_native_trajectory_alignment.py \
    --samples-per-source 10 --run-cerebras
```

This writes ignored review artifacts under `data/native/audit/`: randomized
raw samples per downloaded dataset, reference simple/wallet/email/calendar
trajectories, real Eliza recorder-stage comparisons, an `eliza_native_v1`
export of real local trajectories for smoke training, per-dataset synthesis
templates for missing components, model-call envelopes for Cerebras and the
Vercel AI Gateway bridge, and a composition audit. See
[`docs/dataset/TRAJECTORY_ALIGNMENT_AUDIT.md`](docs/dataset/TRAJECTORY_ALIGNMENT_AUDIT.md).

### Quick reference

```bash
# Build train/val/test directly from runtime trajectory exports
uv run --extra train python scripts/trajectories_to_sft.py \
    --input ../trajectory-export.jsonl \
    --output-dir data/trajectory-runs/local-review

# One-command local APOLLO fine-tune from trajectory export(s)
uv run --extra train python scripts/run_pipeline.py \
    --registry-key qwen3.5-2b \
    --trajectory-export ../trajectory-export.jsonl \
    --epochs 1 --skip-base-bench

# Smoke test on 0.8B (smallest active eliza-1 size, trains on 16 GB)
uv run --extra train python scripts/run_pipeline.py \
    --registry-key qwen3.5-0.8b --max-samples 1000 --epochs 1

# Full pipeline on 2B (eliza-1-2b, real local run)
uv run --extra train python scripts/run_pipeline.py \
    --registry-key qwen3.5-2b --epochs 3

# Remote GPU pipeline for the active 4B APOLLO tier
VAST_API_KEY=... HUGGING_FACE_HUB_TOKEN=... \
    bash scripts/train_vast.sh provision-and-train \
    --registry-key qwen3.5-4b --epochs 1 --bootstrap hf

# Push the trained checkpoint to elizaos/eliza-1
HF_TOKEN=hf_xxx uv run python scripts/push_model_to_hf.py \
    --registry-key qwen3.5-4b \
    --checkpoint checkpoints/qwen3-5-4b-apollo/final
```

See `RL_STRATEGY.md` for the post-SFT plan (DPO + GRPO via verl).

### Renting GPUs

The active 0.8B, 2B, and 4B APOLLO tiers can train on **Vast.ai** via `scripts/train_vast.sh`
(subcommands: `search`, `provision`, `sync`, `run`,
`quantize`, `bench`, `fetch`, `status`, `pull-checkpoints`,
`kill-and-teardown`, `teardown`, `provision-and-train`). The script
auto-picks the GPU target from `REGISTRY_KEY`:

- `qwen3.5-0.8b` / `eliza-1-0_8b` → smallest active smoke/default tier.
- `qwen3.5-2b` / `eliza-1-2b` → local 16 GB training tier.
- `qwen3.5-4b` / `eliza-1-4b` → 48 GB-class training tier, optimized for 24 GB inference after quantization.

Lower-level helpers live in `scripts/lib/vast.py` (searchable via
`python -m scripts.lib.vast pick blackwell6000-2x`). `scripts/day0_smoke.sh`
uses the same helpers for its day-0 verification run. `scripts/train_nebius.sh`
is kept only as an emergency fallback if Vast capacity is unavailable; do not
extend the Nebius path.

### Implementation details

- **APOLLO** — `scripts/training/optimizer.py` (`apollo-torch` package).
  Validation: `scripts/training/test_apollo.py`.
- **PolarQuant** — `scripts/quantization/polarquant_apply.py` plus the
  vendored `scripts/quantization/polarquant/` library. 4-bit weight codes
  + fp16 norms in a sidecar safetensors.
- **TurboQuant** — `scripts/quantization/turboquant_apply.py` (`turbokv`
  package, pure-PyTorch reference) and
  `scripts/quantization/fused_turboquant_apply.py` (Triton-fused, vendored
  in `scripts/quantization/fused_turboquant_vendored/`). Inference-time KV
  cache quantizer.
- **QJL** — `scripts/quantization/qjl_apply.py` plus the vendored
  `scripts/quantization/qjl/` CUDA extension. 1-bit JL-projected K cache.
- **Instrumentation** — `scripts/training/instrumentation.py`. JSONL trace
  with peak memory + tokens/sec per logging window; hard-fails the run
  when `torch.cuda.max_memory_reserved()` exceeds the registry budget by
  more than 10 %.
- **Benchmark** — `scripts/benchmark/native_tool_call_bench.py`. It scores
  expected native tool names, argument keys, and JSON routing/planner shape.
  Run on base + fine-tuned + each quantized variant for direct A/B numbers.

## Uniform chat format

The primary trajectory-training record is an `eliza_native_v1` boundary row.
The renderer reads `request.messages` or `request.prompt`, appends the
supervised assistant turn from `response.text` and/or `response.toolCalls`, and
passes `request.tools` into `tokenizer.apply_chat_template(..., tools=...)`
when the tokenizer supports native tool rendering.

```
{
  "format": "eliza_native_v1",
  "request": {"messages": [...], "tools": {...}, "toolChoice": "..."},
  "response": {"text": "...", "toolCalls": [...]}
}
```

The same chat template is applied at benchmark time with
`add_generation_prompt=True`, so the model sees the same request structure at
training and generation time.

For handoff compatibility, `scripts/format_for_training.py` also accepts
trainable `eliza.eliza1_trajectory_record.v1` message rows, already-rendered
chat-message rows with a final assistant turn, and legacy flat `ElizaRecord`
rows from `pack_dataset.py`. It rejects `repair_eval` / failed-quality rows.
Remote Vast bootstrap expects root split names
`data/final/{train,val,test}.jsonl`; candidate repos use
`data/validation.jsonl`, so stage or rename that split to `val.jsonl` before
using it as the remote root dataset.

## System prerequisites

Three of the four memory optimizations rely on JIT-compiled or
hand-written CUDA kernels:

- **Liger kernel** (training): Triton JIT — needs `gcc` + Python dev
  headers.
- **Fused TurboQuant** (inference V cache): same Triton JIT requirements.
- **QJL** (inference K cache): hand-written CUDA C++ extensions in
  `scripts/quantization/qjl/csrc/` — needs `nvcc` from the CUDA toolkit
  in addition to Python dev headers.
- **PolarQuant** and **APOLLO**: pure-PyTorch / pip — no system deps.

One-shot install on Debian/Ubuntu:

```bash
sudo apt install build-essential python3.12-dev nvidia-cuda-toolkit
# Then build QJL:
cd scripts/quantization/qjl && python setup.py build_ext --inplace
# For Blackwell (sm_120, RTX 50-series + RTX Pro Blackwell):
TORCH_CUDA_ARCH_LIST="12.0+PTX" python setup.py build_ext --inplace
```

Without these, every kernel path has a documented fallback (Liger → HF
defaults; fused-turboquant → pure-PyTorch turbokv; QJL → bf16 K cache —
you lose the K-side compression but retain V-side TurboQuant). The
training/inference script logs a warning at startup so you know which
path is actually running.

## Quickstart

```bash
cd training
uv sync --extra train
uv run python scripts/download_datasets.py
uv run python scripts/extract_eliza_prompts.py
uv run python scripts/normalize.py
uv run python scripts/synthesize_targets.py --task should_respond  # optional
uv run python scripts/pack_dataset.py

# Smoke test (small subset, no Liger — proves the path end to end on 2B)
uv run --extra train python scripts/train_local.py \
    --registry-key qwen3.5-2b --max-samples 256 --epochs 1 \
    --use-liger off

# Real local 2B run with Liger (8k seq_len, APOLLO, instrumentation)
uv run --extra train python scripts/train_local.py \
    --registry-key qwen3.5-2b --epochs 3 --full-finetune \
    --max-chars 24000

# Full pipeline: base bench → APOLLO SFT → fine-tuned bench → quant → quant bench
uv run --extra train python scripts/run_pipeline.py \
    --registry-key qwen3.5-2b --epochs 3
```

For cloud-tier runs see `scripts/train_vast.sh` and `scripts/CLOUD_VAST.md`.
`scripts/train_nebius.sh` is emergency fallback only.
For inference see `scripts/inference/serve_vllm.py` (vLLM serve launcher) and
`scripts/inference/serve_local.py`.

## Memory budgets

The full quantization stack at inference is:

- **APOLLO / APOLLO-Mini** at training time — projected optimizer state
  keeps the 2B local run inside the consumer-GPU budget.
- **PolarQuant** — 4-bit weight quantization (arXiv:2603.29078).
- **QJL** — 1-bit JL-projected K cache (arXiv:2406.03482).
- **Fused TurboQuant** — Triton-fused 4-bit V cache (arXiv:2504.19874).

Run `scripts/training/memory_calc.py` for the actual numbers — every
table below comes from there. **Do not transcribe these tables into other
docs**; the calculator is the source of truth.

```bash
uv run --extra train python scripts/training/memory_calc.py --shape qwen3.5-2b
uv run --extra train python scripts/training/memory_calc.py --shape qwen3.5-4b
```

The `memory_calc` output covers APOLLO training memory across `seq_len ∈
{4k…147k}`, inference memory at the same context lengths for every
(weight-quant, K-quant, V-quant)
combination, an inference fit table across modern local GPUs, and the maximum
context per card with the full quant stack.

### Reality on Qwen3.5 V-side

Upstream `fused_turboquant.hf` 0.1.0's `make_fused_attention_forward`
does not handle the gated `q_proj` layout (`q_proj.out_features =
2 * num_heads * head_dim`) used by the Qwen3.5 attention block.
The vendored `quantization.fused_turboquant_vendored` package adds the
gated branch; until that lands and is smoke-tested end-to-end the V-side
path stays on bf16. K-side QJL is independent of the gated patch and is
on today against the head_dim=256 CUDA kernel.
