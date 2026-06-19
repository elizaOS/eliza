# Eliza-1 Fine-Tuning Pipeline

This document covers the complete end-to-end pipeline for training, evaluating,
quantizing, and publishing the five Eliza-1 model tiers.

---

## Overview: 5-Step Pipeline

```
Step 1: Data preparation   → data/final/{train,val,test}.jsonl
Step 2: Fine-tune (SFT)    → checkpoints/<run>/final/
Step 3: Eval               → checkpoints/<run>/evals/aggregate.json
Step 4: Quantize           → checkpoints/<run>/final-{turboquant,polarquant,qjl}/
Step 5: Publish            → elizaos/eliza-1/bundles/<tier>/
```

All steps are orchestrated by the scripts in `packages/training/scripts/`. The
single-tier entry point is `run_pipeline.py`. The multi-tier entry point (all
five tiers in one command) is `finetune_all_tiers.py`.

---

## Prerequisites

- **Python 3.11+** (3.12 recommended; tested on 3.11 and 3.12)
- **CUDA 12.1+** and NVIDIA driver 570+ (H100/H200/A100 for 9B/27B tiers)
- **uv** package manager: `curl -LsSf https://astral.sh/uv/install.sh | sh`
- **bun install** from the repo root (for the Electrobun/app-core parts)
- **HF_TOKEN** — HuggingFace write token; required for publish steps
- **NEBIUS_API_KEY** / **NEBIUS_PROJECT_ID** — required only for Nebius cloud runs
- **CEREBRAS_API_KEY** — required only for `benchmark_vs_cerebras.py`

Install Python dependencies:

```bash
cd packages/training
uv sync --extra train
```

---

## Step-by-Step Commands

### Step 1: Data Preparation

Build the training corpus from scratch (downloads + normalizes + packs):

```bash
uv run python scripts/run_pipeline.py \
    --registry-key qwen3.5-2b \
    --from-scratch \
    --skip-base-bench --skip-finetune --skip-quantize --skip-bench
```

Or place pre-built splits directly at:
```
data/final/train.jsonl
data/final/val.jsonl
data/final/test.jsonl
```

Validate corpus before training (mandatory per AGENTS.md):

```bash
uv run --extra train python scripts/validate_corpus.py \
    --input data/final/train.jsonl --strict
```

### Step 2: Fine-Tune

**Single tier** (recommended for development):

```bash
uv run --extra train python scripts/run_pipeline.py \
    --registry-key qwen3.5-2b \
    --epochs 3 --lr 1e-5 \
    --run-name eliza-1-2b-v1 \
    --skip-base-bench --skip-quantize
```

**All tiers** (sequential, local GPUs):

```bash
uv run --extra train python scripts/finetune_all_tiers.py \
    --data-path data/final \
    --output-dir checkpoints
```

**All tiers, dry run** (preview commands without executing):

```bash
uv run python scripts/finetune_all_tiers.py \
    --data-path data/final --dry-run
```

**Specific tiers only**:

```bash
uv run --extra train python scripts/finetune_all_tiers.py \
    --tiers qwen3.5-0.8b,qwen3.5-2b \
    --data-path data/final
```

**Skip quantization** (faster iteration):

```bash
uv run --extra train python scripts/finetune_all_tiers.py \
    --tiers qwen3.5-0.8b \
    --data-path data/final \
    --skip-quant
```

### Step 3: Evaluate

Evaluate a checkpoint:

```bash
uv run --extra train python scripts/eval_checkpoint.py \
    --checkpoint checkpoints/eliza-1-2b-v1/final \
    --registry-key qwen3.5-2b \
    --val-jsonl data/final/val.jsonl \
    --out reports/eval-2b.json
```

Run the full benchmark suite vs Cerebras:

```bash
export CEREBRAS_API_KEY=...
uv run --extra train python scripts/benchmark_vs_cerebras.py \
    --tiers qwen3.5-2b,qwen3.5-4b \
    --benchmark all \
    --max-samples 500 \
    --output-dir reports/cerebras-comparison
```

### Step 4: Quantize

The quantization pipeline runs automatically inside `run_pipeline.py` and
`finetune_all_tiers.py`. To run it manually on an existing checkpoint:

```bash
# TurboQuant
uv run --extra train python scripts/quantization/turboquant_apply.py \
    --model checkpoints/<run>/final \
    --output checkpoints/<run>/final-turboquant \
    --calibration data/final/val.jsonl \
    --calibration-samples 128

# PolarQuant
uv run --extra train python scripts/quantization/polarquant_apply.py \
    --model checkpoints/<run>/final \
    --output checkpoints/<run>/final-polarquant \
    --calibration data/final/val.jsonl \
    --calibration-samples 128

# QJL
uv run --extra train python scripts/quantization/qjl_apply.py \
    --model checkpoints/<run>/final \
    --output checkpoints/<run>/final-qjl \
    --calibration data/final/val.jsonl \
    --calibration-samples 128
```

For the full Eliza-1 GGUF bundle (PolarQuant + QJL + TurboQuant sidecars):

```bash
uv run --extra train python scripts/optimize_for_eliza1.py \
    --base-model checkpoints/<run>/final \
    --output-dir checkpoints/<run>/eliza1-optimized \
    --apply polarquant qjl turboquant fused_turboquant \
    --calibration data/final/val.jsonl \
    --calibration-samples 128 \
    --llama-cpp-dir /path/to/eliza-llama-cpp
```

### Step 5: Publish

**Dry run first:**

```bash
uv run python scripts/publish_all_finetuned.py --what all --dry-run
```

**Publish models:**

```bash
export HF_TOKEN=hf_xxxx
uv run python scripts/publish_all_finetuned.py \
    --what models \
    --tiers qwen3.5-0.8b,qwen3.5-2b
```

**Publish datasets:**

```bash
export HF_TOKEN=hf_xxxx
uv run python scripts/publish_all_finetuned.py --what datasets
```

**Publish everything:**

```bash
export HF_TOKEN=hf_xxxx
uv run python scripts/publish_all_finetuned.py --what all
```

The full gated publish (eval gates + kernel verification + manifest generation)
goes through the orchestrator:

```bash
uv run python -m scripts.publish.orchestrator \
    --tier eliza-1-2b \
    --bundle-dir checkpoints/<run>/eliza1-optimized
```

---

## APOLLO Optimizer

**Why APOLLO:** Full-parameter SFT on large models with AdamW requires storing
two momentum tensors per parameter (2× model size in optimizer state). APOLLO
replaces those tensors with a low-rank random projection that approximates the
second moment. For the 2B tier this drops optimizer peak memory from ~28 GB to
~15.5 GB — the difference between needing a 40 GB A100 and fitting on a 16 GB
consumer GPU.

**Memory savings vs AdamW:**

| Tier       | AdamW peak | APOLLO peak | Savings |
|------------|-----------|-------------|---------|
| qwen3.5-0.8b | ~18 GB  | ~12 GB      | ~33%    |
| qwen3.5-2b   | ~26 GB  | ~15.5 GB    | ~40%    |
| qwen3.5-4b   | ~44 GB  | ~28 GB      | ~36%    |
| qwen3.5-9b   | ~120 GB | ~80 GB      | ~33%    |
| qwen3.6-27b  | ~280 GB | ~190 GB     | ~32%    |

**APOLLO variants:**

- `apollo_mini` (rank 1): Used for 0.8B, 2B, 4B, 27B tiers. Rank-1
  projection — minimum optimizer state, good for tight GPU budgets.
- `apollo` (rank 512): Used for the 9B tier. Higher rank = more accurate
  gradient approximation at the cost of more optimizer memory.

**Training always uses APOLLO.** The AGENTS.md contract is explicit: do not
swap to AdamW/Muon or any other optimizer without operator approval. The
release flow expects APOLLO-trained checkpoints.

---

## Per-Tier Requirements

| Tier         | GPU Memory | Seq Len | Est. Train Time (1 epoch) | Tier Type    |
|--------------|-----------|---------|--------------------------|--------------|
| qwen3.5-0.8b | 12 GB     | 4096    | ~1–2h (consumer GPU)     | local        |
| qwen3.5-2b   | 15.5 GB   | 8192    | ~3–4h (16 GB GPU)        | local        |
| qwen3.5-4b   | 28 GB     | 8192    | ~4–6h (24–28 GB GPU)     | local        |
| qwen3.5-9b   | 80 GB     | 16384   | ~12–18h (H100 SXM)       | workstation  |
| qwen3.6-27b  | 190 GB    | 65536   | ~24–48h (2× H200)        | cloud        |

Notes:
- Training time estimates assume full-corpus SFT, Liger fused CE, `--epochs 1`.
- The 27B tier requires FSDP across 2× H200 or 8× H100 — use `train_nebius.sh`
  or `train_vast.sh`. Set `ELIZA_FORCE_LOCAL_TRAIN=1` only on hardware that
  actually fits the 190 GB budget.
- Cap training with `--max-steps` when wall-clock matters:
  `--max-steps 1500` fits a 12h H200 budget at ~25 s/iter.
- Validate VRAM before running: `python scripts/training/memory_calc.py --shape <tier>`.

---

## Quantization: TurboQuant + PolarQuant + QJL

Three complementary quantization methods are applied post-training. All three
are mandatory per AGENTS.md §3.

### TurboQuant / fused_turboquant

**What it does:** 4-bit quantization of the value-cache (V in KV-attention) at
inference time. The fused variant bakes the quantization into the model weights
so no separate V-cache sidecar is needed at runtime.

**When applied:** After SFT, on the bf16/fp16 checkpoint. Run before PolarQuant
because it operates on the same weight layout. The `fused_turboquant` pass is
the preferred runtime variant; plain `turboquant` produces a sidecar JSON for
the non-fused inference path.

### PolarQuant

**What it does:** 4-bit quantization of model weights using polar codebooks +
sign vectors. Reduces the on-disk and in-memory weight footprint by ~4× vs
bf16 while preserving quality better than naive int4 (sign vectors capture the
asymmetric structure of transformer weights).

**When applied:** After TurboQuant, on the unmodified bf16 checkpoint (not the
TurboQuant output). Each recipe operates on the base checkpoint independently.

### QJL (Quantized JL Transform)

**What it does:** 1-bit (measured ~7.5× compression from per-token norm
overhead) quantization of the key-cache (K in KV-attention) via a Johnson-
Lindenstrauss random projection. Reduces peak KV-cache memory for long-context
inference without losing the asymptotic 128k+ context capability.

**When applied:** Last in the pipeline, after TurboQuant and PolarQuant.
Requires the `kv_layers` count from `model_registry.py` to be correct — verify
with `python -c "from training.model_registry import get; e=get('qwen3.5-2b'); print(e.infer_kv_layers)"`.

**Pipeline order (binding, per AGENTS.md §3):**

```
bf16 checkpoint
  │
  ├── turboquant_apply.py / fused_turboquant_apply.py
  ├── polarquant_apply.py
  └── qjl_apply.py
```

Each recipe must emit a quantization manifest sidecar. Each recipe runs its own
`test_*.py` before exit. Failing tests are publish-blocking.

---

## Eval Gates

Eval gates are defined per tier in `benchmarks/eliza1_gates.yaml`. The publish
orchestrator loads this file via `benchmarks/eliza1_gates.py::load_gates` and
refuses to publish if any `required: true` gate fails.

**Required gates (all tiers):**

| Gate                  | Metric                         | Direction |
|-----------------------|-------------------------------|-----------|
| `text_eval`           | Held-out text quality (0..1)  | ≥ threshold |
| `voice_rtf`           | TTS real-time factor          | ≤ threshold |
| `asr_wer`             | ASR word error rate           | ≤ threshold |
| `vad_latency_ms`      | VAD speech-onset latency (ms) | ≤ threshold |
| `barge_in_cancel_ms`  | Barge-in cancel latency (ms)  | ≤ threshold |
| `thirty_turn_ok`      | 30-turn endurance bool        | true |
| `e2e_loop_ok`         | End-to-end voice loop bool    | true |

**Per-tier text_eval thresholds:**

| Tier    | text_eval threshold |
|---------|---------------------|
| 0_8b    | 0.55                |
| 2b      | 0.60                |
| 4b      | 0.62                |
| 9b      | 0.64                |
| 27b     | 0.66                |

**`provisional: true`** means the threshold is calibrated but not yet
enforced as publish-blocking. Provisional gates are recorded in the manifest and
reported, but a provisional failure does not flip `defaultEligible` to false.
Flip to `provisional: false` once the e2e harness reproduces the threshold on
reference hardware.

**`needs_hardware: true`** gates (peak_rss_mb, thermal_throttle_pct) cannot be
evaluated off-device. A publish run on a host without the device records them as
`null`, not as a pass. The CI matrix runs these nightly on real devices.

---

## Nebius Instructions

Nebius is the emergency cloud fallback (Vast.ai is the canonical cloud).

### Prerequisites

```bash
export NEBIUS_PROJECT_ID=project-e00kfz6cpr00q21z892vec
export HUGGING_FACE_HUB_TOKEN=hf_xxxx
```

### Submit a training run

```bash
# Single tier (0.8B through 9B — single H200)
REGISTRY_KEY=qwen3.5-2b bash scripts/train_nebius.sh full

# With a step cap (fits 12h H200 budget)
REGISTRY_KEY=qwen3.5-9b MAX_STEPS=1500 bash scripts/train_nebius.sh full
```

For the 27B tier, Nebius only offers 1-GPU or 8-GPU presets. The 8-GPU preset
is expensive (~$240+/h). Prefer Vast for 27B:

```bash
# 27B on Nebius (confirm cost before running)
REGISTRY_KEY=qwen3.6-27b NEBIUS_VM_PRESET=gpu-h200x2 \
    FSDP_WORLD_SIZE=8 bash scripts/train_nebius.sh full
```

Generate Nebius manifests without submitting (for review):

```bash
uv run python scripts/finetune_all_tiers.py \
    --nebius \
    --tiers qwen3.5-2b,qwen3.5-9b \
    --data-path data/final \
    --output-dir checkpoints
```

### Monitor a running job

```bash
# Print the VM public IP
bash scripts/train_nebius.sh ip

# SSH in and tail the log
ssh ubuntu@$(bash scripts/train_nebius.sh ip)
tail -f /opt/training/run_<run-name>.log
```

### Pull checkpoints

```bash
RUN_NAME=eliza-1-2b-apollo-1234567890 bash scripts/train_nebius.sh fetch
```

### Teardown

```bash
bash scripts/train_nebius.sh teardown
```

---

## Common Issues and Fixes

### `torch.cuda.is_available()` returns False on Nebius

The Nebius `cuda12.8` public image ships driver 570.x; the pinned torch
(`cu130`) requires driver ≥580. The launcher auto-detects and swaps to
`torch==2.11.0+cu128`, which the 570.x driver supports.

If you hit this manually:
```bash
.venv/bin/python -c 'import torch; print(torch.cuda.is_available())'
# If False:
uv pip uninstall torch torchvision triton
uv pip install torch==2.11.0 --index-url https://download.pytorch.org/whl/cu128
```

### OOM during SFT

Use `memory_calc.py` to predict peak memory before running:
```bash
uv run python scripts/training/memory_calc.py --shape qwen3.5-9b
```

Reduce seq_len via `--max-seq-len`. The 10% tolerance before OOM abort is
enforced by `instrumentation.py`. For consumer GPUs use `--low-vram-smoke`
(seq_len=2048, batch=1, budget=11.5 GB — not publishable).

### `TypeError: Can only get item pairs from a mapping` during Dataset.map

Tool-call arguments stored as JSON strings instead of dicts. Fixed automatically
by `train_local.py`'s `_coerce_tool_call_arguments` pass. If you see this in a
custom script, call `format_record()` from `format_for_training.py` on each
record before passing to the tokenizer.

### Corpus validation failure

```bash
uv run --extra train python scripts/validate_corpus.py \
    --input data/final/train.jsonl \
    --report reports/validation.json \
    --strict
```

Inspect `reports/validation.json` for the failing records. Common causes:
missing required fields in native trajectory records, or ChatML-format records
mixed with native-format records (use `--allow-unvalidated-corpus` only as a
last resort — the format_record gate still runs at training time).

### Liger kernel disabled: Triton probe failed

```
Triton runtime probe failed — Liger kernel disabled
Fix: install the Python dev headers for this interpreter:
  apt install python3.11-dev
```

Without Liger, the fp32 logits transient (B×S×V×4 bytes, V=248k) limits
effective seq_len to ~4096 at 16 GB. Use `--use-liger off` to confirm Liger
is the issue; fix the dev headers for a real run.

### Quantizer script not found

Run from `packages/training/` and check the script exists:
```bash
ls scripts/quantization/turboquant_apply.py
```

All quantizer scripts follow the `<name>_apply.py` naming convention.

### HF push fails: `Repository not found`

Ensure `HF_TOKEN` has write access to `elizaos/eliza-1`. The token owner must
be a collaborator on the repo. Test with:
```bash
python -c "from huggingface_hub import HfApi; api = HfApi(); api.whoami()"
```

---

## Key Files Reference

| File | Purpose |
|------|---------|
| `scripts/training/model_registry.py` | Single source of truth for tier configs |
| `scripts/train_local.py` | Single-GPU APOLLO SFT entry point |
| `scripts/run_pipeline.py` | Single-tier end-to-end pipeline |
| `scripts/finetune_all_tiers.py` | Multi-tier orchestrator |
| `scripts/eval_checkpoint.py` | Checkpoint scoring |
| `scripts/benchmark_vs_cerebras.py` | Benchmark vs Cerebras comparison |
| `scripts/publish_all_finetuned.py` | Publish models + datasets to HF |
| `scripts/publish/orchestrator.py` | Full gated bundle publish |
| `scripts/quantization/*_apply.py` | Quantization recipes |
| `scripts/train_nebius.sh` | Nebius cloud launcher |
| `scripts/train_vast.sh` | Vast.ai cloud launcher (canonical) |
| `benchmarks/eliza1_gates.yaml` | Per-tier eval gate thresholds |
| `AGENTS.md` | Training contract (canonical) |
