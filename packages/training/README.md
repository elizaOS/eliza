# eliza-1 — Training Pipeline

Fine-tunes the **eliza-1** model series (`eliza-1-2b`,
`eliza-1-4b`, `eliza-1-9b`, `eliza-1-27b`) on Eliza-native Vercel AI SDK
trajectory rows: the exact
request sent to the model plus the exact normalized response returned by the
model, including native tool calls.

> **This directory is gitignored.** The canonical artifact stores live on
> HuggingFace, not in git history:
>
> | what                              | repo                                      | script                          |
> |-----------------------------------|-------------------------------------------|---------------------------------|
> | Dataset (native trajectory SFT)   | runtime `eliza_native_v1` exports          | `scripts/trajectories_to_sft.py`|
> | Trained models                    | `elizaos/eliza-1` (model; `bundles/<tier>/`) | `scripts/publish/publish_model.py` |
> | Training dataset (SFT splits)     | `elizaos/eliza-1-training` (dataset)         | `scripts/publish/publish_dataset.py` |
> | Pipeline source (this directory)  | `elizaos/eliza-1-training` (dataset; `pipeline/`) | `scripts/publish/publish_pipeline.py` |
>
> Quants land under the same `elizaos/eliza-1` model repo alongside each
> bundle manifest; do not create per-quant public defaults.

The base models are catalogued in `scripts/training/model_registry.py`;
each entry is tagged `local | workstation | cloud`. Default optimizer is
**APOLLO** (full-parameter SFT, low-memory projected optimizer state,
arXiv:2412.05270), not LoRA.

| registry key | eliza release | base               | tier        | default training target             | optimizer    |
|--------------|---------------|--------------------|-------------|-------------------------------------|--------------|
| gemma4-e2b   | eliza-1-2b    | google/gemma-4-E2B | local       | 16 GB consumer GPU                  | apollo_mini  |
| gemma4-e4b   | eliza-1-4b    | google/gemma-4-E4B | local       | 24 GB consumer/workstation GPU      | apollo_mini  |
| gemma4-12b   | eliza-1-9b    | google/gemma-4-12B | workstation | 80 GB-class GPU                     | apollo       |
| gemma4-31b   | eliza-1-27b   | google/gemma-4-31B | cloud       | 2x H200 / B200                      | apollo       |

After training, the Gemma publish path produces stock llama.cpp GGUF
K-quant release artifacts (`Q4_K_M` for the shipping local tier, plus
`Q6_K` / `Q8_0` where a tier explicitly requires them) and MTP drafter
manifests for speculative decoding. The older recipe stack is split by
what it actually changes: **TurboQuant** and **QJL** are runtime KV-cache
compressors, while **PolarQuant** is a weight quantizer. Gemma 4's MQA +
windowed SWA KV layout makes those optional rather than default release
gates, and a sidecar is not publish provenance unless the recipe actually
ran for that tier.

A unified pipeline runner (`scripts/run_pipeline.py`) chains:

  base bench → APOLLO SFT → fine-tuned bench → GGUF q4/q6/q8 + MTP manifest → quantized bench

Per-task benchmarks live in `scripts/benchmark/native_tool_call_bench.py` and
score native tool-call structure, tool names, argument keys, and JSON routing
shape on the held-out trajectory split.

## Cloning the pipeline on a fresh machine

```bash
hf download elizaos/eliza-1-training pipeline --repo-type dataset --local-dir ./training
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
              (APOLLO, E2B/E4B)     (APOLLO, remote GPU)
                                  │
                                  ▼
              ┌─────────────┬─────┴─────┬─────────────┐
              ▼             ▼           ▼             ▼
       GGUF release K-quant  MTP drafter verify  optional recipe experiments
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
    --registry-key gemma4-e2b \
    --trajectory-export ../trajectory-export.jsonl \
    --epochs 1 --skip-base-bench

# Smoke test on E2B (entry active eliza-1 size, trains on 16 GB)
uv run --extra train python scripts/run_pipeline.py \
    --registry-key gemma4-e2b --max-samples 1000 --epochs 1

# Full pipeline on E2B (eliza-1-2b, real local run)
uv run --extra train python scripts/run_pipeline.py \
    --registry-key gemma4-e2b --epochs 3

# Remote GPU pipeline for the active E4B APOLLO tier
VAST_API_KEY=... HUGGING_FACE_HUB_TOKEN=... \
    bash scripts/train_vast.sh provision-and-train \
    --registry-key gemma4-e4b --epochs 1 --bootstrap hf

# Push the trained checkpoint to elizaos/eliza-1 (gated bundle path).
# publish_model.py --mode bundle runs the full publish orchestrator:
# layout → kernel verify → eval gates (incl. prior-bundle regression check) →
# manifest → README → HF push.
HF_TOKEN=hf_xxx uv run python -m scripts.publish.publish_model \
    --mode bundle \
    --tier 4b \
    --bundle-dir checkpoints/gemma4-e4b-apollo/final
```

See `RL_STRATEGY.md` for the post-SFT plan (DPO + GRPO via verl).

### Renting GPUs

The active E2B, E4B, 12B, and 31B APOLLO tiers can train on **Vast.ai** via `scripts/train_vast.sh`
(subcommands: `search`, `provision`, `sync`, `run`,
`quantize`, `bench`, `fetch`, `status`, `pull-checkpoints`,
`kill-and-teardown`, `teardown`, `provision-and-train`). The script
auto-picks the GPU target from `REGISTRY_KEY`:

- `gemma4-e2b` / `eliza-1-2b` → entry local 16 GB training tier.
- `gemma4-e4b` / `eliza-1-4b` → 48 GB-class training tier, optimized for local inference after quantization.
- `gemma4-12b` / `eliza-1-9b` → workstation tier.
- `gemma4-31b` / `eliza-1-27b` → cloud tier.

Lower-level helpers live in `scripts/lib/vast.py` (searchable via
`python -m scripts.lib.vast pick blackwell6000-2x`). `scripts/day0_smoke.sh`
uses the same helpers for its day-0 verification run. `scripts/train_nebius.sh`
is kept only as an emergency fallback if Vast capacity is unavailable; do not
extend the Nebius path.

### Implementation details

- **APOLLO** — `scripts/training/optimizer.py` (`apollo-torch` package).
  Validation: `scripts/training/test_apollo.py`.
- **GGUF release quantization** — `scripts/quantization/gguf_eliza1_apply.py`
  is used by the supported Gemma bundle staging path to produce the q4/q6/q8
  artifacts consumed by the local inference manifests. The old
  `scripts/optimize_for_eliza1.py` `eliza1-optimized` wrapper was retired.
- **MTP drafter verify** — Gemma 4 uses separate official drafter checkpoints;
  publish gates validate the drafter manifest rather than same-model EAGLE
  distillation.
- **Legacy KV recipes** — `scripts/quantization/polarquant_apply.py`,
  `scripts/quantization/turboquant_apply.py`, and `scripts/quantization/qjl_apply.py`
  remain available for experiments but are not required Gemma release gates.
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

The active Gemma training path only requires the normal PyTorch stack, with
Liger strongly recommended for the entry local tier. Legacy KV recipes still
have their own build requirements when you run those experimental paths:

- **Liger kernel** (training): Triton JIT — needs `gcc` + Python dev
  headers.
- **Legacy Fused TurboQuant** (inference V cache): same Triton JIT requirements.
- **Legacy QJL** (inference K cache): hand-written CUDA C++ extensions in
  `scripts/quantization/qjl/csrc/` — needs `nvcc` from the CUDA toolkit
  in addition to Python dev headers.
- **GGUF release quantization**, **APOLLO**, and **PolarQuant**: pure-PyTorch /
  pip — no system deps.

One-shot install on Debian/Ubuntu:

```bash
sudo apt install build-essential python3.12-dev nvidia-cuda-toolkit
# Then build QJL:
cd scripts/quantization/qjl && python setup.py build_ext --inplace
# For Blackwell (sm_120, RTX 50-series + RTX Pro Blackwell):
TORCH_CUDA_ARCH_LIST="12.0+PTX" python setup.py build_ext --inplace
```

Without Liger, `train_local.py` falls back to HF defaults and the 12 GB smoke
lane has much less headroom. The legacy KV paths also keep documented fallbacks
(fused-turboquant → pure-PyTorch turbokv; QJL → bf16 K cache). The
training/inference scripts log a warning at startup so you know which path is
actually running.

## Quickstart

```bash
cd training
uv sync --extra train
uv run python scripts/download_datasets.py
uv run python scripts/extract_eliza_prompts.py
uv run python scripts/normalize.py
uv run python scripts/synthesize_targets.py --task should_respond  # optional
uv run python scripts/pack_dataset.py

# Smoke test (small subset, no Liger — proves the path end to end on E2B)
uv run --extra train python scripts/train_local.py \
    --registry-key gemma4-e2b --max-samples 256 --epochs 1 \
    --use-liger off

# Real local E2B run with Liger (8k seq_len, APOLLO, instrumentation)
uv run --extra train python scripts/train_local.py \
    --registry-key gemma4-e2b --epochs 3 --full-finetune \
    --max-chars 24000

# Full pipeline: base bench → APOLLO SFT → fine-tuned bench → quant → quant bench
uv run --extra train python scripts/run_pipeline.py \
    --registry-key gemma4-e2b --epochs 3
```

For cloud-tier runs see `scripts/train_vast.sh` and `scripts/CLOUD_VAST.md`.
`scripts/train_nebius.sh` is emergency fallback only.
For inference see `scripts/inference/serve_vllm.py` (vLLM serve launcher) and
`scripts/inference/serve_local.py`.

## Targeting a 12 GB consumer GPU budget

The registry's `gemma4-e2b` default targets a 16 GB local GPU (seq_len=8192,
budget=15.5 GB). On a 12 GB card that can OOM at the fp32 logits transient
(B·S·V·4 bytes; Gemma 4 vocab=262k makes this dominant). The `--low-vram-smoke`
flag is a preset bundle that reduces the sequence and batch settings and sets
an 11.5 GB nominal reserved-memory budget. Those settings are a target, not
proof that a particular model, kernel stack, or allocator fits a 12 GB card.

```bash
# E2B — the entry active tier for a 12 GB smoke.
uv run --extra train python scripts/train_local.py \
    --registry-key gemma4-e2b --low-vram-smoke

# E4B — use only for preflight or machines with extra VRAM headroom.
uv run --extra train python scripts/train_local.py \
    --registry-key gemma4-e4b --low-vram-smoke
```

What the preset overrides (CLI flags the caller passes still win):

- `seq_len = 2048`                    (registry default 8192 for E2B, 4096 for E4B)
- `per_device_batch_size = 1`
- `gradient_accumulation_steps = 16`  (effective batch stays at 16)
- `max_samples = 1000`
- `epochs = 1`
- `memory_budget_gb = 11.5`           (the callback permits the configured 10% tolerance)
- Liger fused chunked-CE stays on (registry default, when installed and
  Triton can JIT-compile — see the System Prerequisites section)
- Activation checkpointing stays on (default in `train_local.py`)
- APOLLO-Mini (registry default for E2B/E4B) remains the optimizer;
  rank=1 keeps optimizer state effectively free.

**Kernel prerequisites for the intended E2B path**. The preset's budget at E2B depends
on Liger fused chunked-CE to reduce the fp32 logits transient over Gemma 4's
262k vocab. Liger requires Triton, which JIT-compiles a small CUDA helper at
the first kernel launch — `gcc`, `python3.x-dev`, and a CUDA toolkit Triton
can use must all be installed. Without them, `train_local.py` logs a warning
at startup and falls back to HF defaults.

When Liger is missing, do not treat the E2B-on-12 GB target as established;
limit local validation to preflight and tiny-model smoke runs unless a measured
model run proves otherwise.

**Verify the input contract without running SFT.** `--preflight-only` validates
the preset's flag bundle, APOLLO option/rank selection, and formatter
compatibility for every loaded corpus row:

```bash
uv run --extra train python scripts/train_local.py \
    --registry-key gemma4-e2b --low-vram-smoke \
    --train-file data/final-eliza1-smoke/train.jsonl \
    --val-file data/final-eliza1-smoke/val.jsonl \
    --preflight-only
# → "low-vram-smoke preset → seq=2048 batch=1 accum=16 ... budget=11.5GB"
# → "preflight ok: train=16/16 validation=2/2 optimizer=apollo_mini rank=1"
```

Preflight does not load a tokenizer or model, render the selected chat template,
route APOLLO parameter groups, initialize Liger/CUDA, or establish hardware
fit. Before treating this preset as runnable on a 12 GB device, execute at least
one real Stage 2 forward/backward step against the exact corpus and checkpoint,
then record the GPU, software stack, corpus hash, and peak allocated/reserved
VRAM. No measured VRAM claim applies to the current synthetic fixture until
that artifact exists.

The instrumentation callback (enabled because `--memory-budget-gb` is set)
fails the run loud the moment `torch.cuda.max_memory_reserved()` exceeds
the budget by more than 10 %.

**Trade-offs:**

- Training context window drops from 4–8k to 2k. Records longer than ~2k
  rendered chars are right-truncated by the tokenizer. The synthetic smoke
  fixture fits inside 2k; for a real native
  trajectory corpus pass `--max-chars 6000` (≈3× seq_len) so the
  char-filter rejects oversized rows up front rather than wasting them.
- Long-context behaviors (multi-turn agent traces, long tool outputs)
  are NOT exercised at seq_len=2048. The resulting checkpoint is for
  smoke / path-validation only, NOT for publishing.
- Loss numbers from the smoke are not comparable to the registry-default
  run — the effective sequence diet is different.

**If it OOMs**: drop seq_len with
`--low-vram-smoke --max-seq-len 1024` (or 768) and retry. If you cannot
install the Liger kernel (Windows / WSL2 without a CUDA toolkit and Python
dev headers), keep this lane to preflight + tiny smoke runs and move full
training to a larger GPU.

## Memory budgets

The full quantization stack at inference is:

- **APOLLO / APOLLO-Mini** at training time — projected optimizer state
  reduces pressure, while a measured run remains the authority on hardware fit.
- **GGUF body quantization** — q4/q6/q8 release artifacts for local inference.
- **MTP drafter** — separate Gemma 4 drafter GGUFs for speculative decoding.
- **Legacy KV recipes** — PolarQuant, QJL, and Fused TurboQuant remain available
  for experiments; Gemma 4 does not require them in the publish path.

Run `scripts/training/memory_calc.py` for the actual numbers — every
table below comes from there. **Do not transcribe these tables into other
docs**; the calculator is the source of truth.

```bash
uv run --extra train python scripts/training/memory_calc.py --shape gemma4-e2b
uv run --extra train python scripts/training/memory_calc.py --shape gemma4-e4b
```

The `memory_calc` output covers APOLLO training memory across `seq_len ∈
{4k…147k}`, inference memory at the same context lengths for every
(weight-quant, K-quant, V-quant)
combination, an inference fit table across modern local GPUs, and the maximum
context per card with the configured quantization combinations.

### Gemma KV Status

Gemma 4 uses dense attention with MQA, windowed SWA, shared KV layers, and
dual KV head dimensions. The current memory calculator intentionally
overestimates KV by treating every KV-bearing layer as full-context at the
global head dimension. Keep the Gemma release path on GGUF body quantization
and MTP drafter verification until a Gemma-aware KV calculator and publish gate
land.
