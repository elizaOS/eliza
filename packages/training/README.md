# eliza-1 — Training Pipeline

Fine-tunes the **eliza-1** model series (`eliza-1-2b`, `eliza-1-9b`,
`eliza-1-27b`) on Eliza-native Vercel AI SDK trajectory rows: the exact
request sent to the model plus the exact normalized response returned by the
model, including native tool calls.

> **This directory is gitignored.** The canonical artifact stores live on
> HuggingFace, not in git history:
>
> | what                              | repo                                      | script                          |
> |-----------------------------------|-------------------------------------------|---------------------------------|
> | Dataset (native trajectory SFT)   | runtime `eliza_native_v1` exports          | `scripts/trajectories_to_sft.py`|
> | Trained models                    | `elizaos/eliza-1-{2b,9b,27b}` (model)     | `scripts/push_model_to_hf.py`   |
> | Pipeline source (this directory)  | `elizaos/eliza-training-pipeline` (model) | `scripts/push_pipeline_to_hf.py`|
>
> Quants land in sibling repos with suffixes (`elizaos/eliza-1-27b-gguf`,
> `elizaos/eliza-1-27b-fp8`, …) — `push_model_to_hf.py --quant <name>`
> resolves the suffix automatically.

The base models are catalogued in `scripts/training/model_registry.py`;
each entry is tagged `local | workstation | cloud`. Default optimizer is
**APOLLO** (full-parameter SFT, low-memory projected optimizer state,
arXiv:2412.05270), not LoRA.

| eliza release | base               | tier        | trains on             | optimizer    |
|---------------|--------------------|-------------|-----------------------|--------------|
| eliza-1-2b    | Qwen/Qwen3.5-2B    | local       | RTX 5080 16 GB        | apollo_mini  |
| eliza-1-9b    | Qwen/Qwen3.5-9B    | workstation | Nebius H200-1×        | apollo       |
| eliza-1-27b   | Qwen/Qwen3.6-27B   | cloud       | Nebius H200-2× (FSDP) | apollo_mini  |

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
hf download elizaos/eliza-training-pipeline --repo-type model --local-dir ./training
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
              train_local.py        train_nebius.sh / train_vast.sh
              (APOLLO, 2B local)    (APOLLO, 9B / 27B on H200 or Blackwell)
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

# Smoke test on 2B (smallest eliza-1 size, trains on 16 GB)
uv run --extra train python scripts/run_pipeline.py \
    --registry-key qwen3.5-2b --max-samples 1000 --epochs 1

# Full pipeline on 2B (eliza-1-2b, real local run)
uv run --extra train python scripts/run_pipeline.py \
    --registry-key qwen3.5-2b --epochs 3

# Cloud pipeline (eliza-1-9b on 1× H200, eliza-1-27b on 2× H200)
NEBIUS_PROJECT_ID=... HUGGING_FACE_HUB_TOKEN=... \
    REGISTRY_KEY=qwen3.6-27b \
    bash scripts/train_nebius.sh full

# Push the trained checkpoint to elizaos/eliza-1-27b
HF_TOKEN=hf_xxx uv run python scripts/push_model_to_hf.py \
    --registry-key qwen3.6-27b \
    --checkpoint checkpoints/qwen3-6-27b-apollo/final
```

See `RL_STRATEGY.md` for the post-SFT plan (DPO + GRPO via verl).

### Renting GPUs

The cloud-tier sizes (`eliza-1-9b`, `eliza-1-27b`) train on **Nebius H200**
via `scripts/train_nebius.sh` (subcommands: `provision`, `sync`, `run`,
`quantize`, `bench`, `fetch`, `teardown`, `full`):

- `eliza-1-9b` → single H200 SXM (`NEBIUS_VM_PRESET=gpu-h200x1`).
- `eliza-1-27b` → 2× H200 SXM with FSDP (`NEBIUS_VM_PRESET=gpu-h200x2`,
  default).

For Vast.ai (alternate provider with cheaper Blackwell GPUs), use
`scripts/train_vast.sh` — same subcommand set, auto-picks the GPU target
from `REGISTRY_KEY`. Lower-level helpers live in `scripts/lib/vast.py`
(searchable via `python -m scripts.lib.vast pick blackwell6000-2x`).
`scripts/day0_smoke.sh` uses the same helpers for its day-0 verification
run.

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

Every trajectory-training record is an `eliza_native_v1` boundary row. The
renderer reads `request.messages` or `request.prompt`, appends the supervised
assistant turn from `response.text` and/or `response.toolCalls`, and passes
`request.tools` into `tokenizer.apply_chat_template(..., tools=...)` when the
tokenizer supports native tool rendering.

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

For cloud-tier runs see `scripts/train_nebius.sh` and `scripts/train_vast.sh`.
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
uv run --extra train python scripts/training/memory_calc.py --shape qwen3.5-9b
uv run --extra train python scripts/training/memory_calc.py --shape qwen3.6-27b
```

The `memory_calc` output covers APOLLO training memory across `seq_len ∈
{4k…147k}`, inference memory at the same context lengths for every
(weight-quant, K-quant, V-quant)
combination, an inference fit table across {RTX 5090, RTX Pro 5000/6000
Blackwell, H100, H200}, and the maximum context per card with the full
quant stack. The 27B fits ≥1M tokens on every listed card; the
architectural cap (1M tokens, native 256k extended via RoPE scaling) is
the binding constraint.

### Reality on Qwen3.5/3.6 V-side

Upstream `fused_turboquant.hf` 0.1.0's `make_fused_attention_forward`
does not handle the gated `q_proj` layout (`q_proj.out_features =
2 * num_heads * head_dim`) used by the Qwen3.5 / Qwen3.6 attention block.
The vendored `quantization.fused_turboquant_vendored` package adds the
gated branch; until that lands and is smoke-tested end-to-end the V-side
path stays on bf16. K-side QJL is independent of the gated patch and is
on today against the head_dim=256 CUDA kernel.
