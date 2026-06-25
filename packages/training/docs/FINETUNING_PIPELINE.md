# Eliza-1 Fine-Tuning Pipeline

This document covers the complete end-to-end pipeline for training, evaluating,
quantizing, and publishing the five Eliza-1 model tiers.

---

## Overview: 5-Step Pipeline

```
Step 1: Data preparation   → data/final/{train,val,test}.jsonl
Step 2: Fine-tune (SFT)    → checkpoints/<run>/final/
Step 3: Eval               → checkpoints/<run>/evals/aggregate.json
Step 4: Quantize           → checkpoints/<run>/final-{gguf-q4,gguf-q6,gguf-q8}/ + MTP metadata
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
    --registry-key gemma4-e2b \
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
    --registry-key gemma4-e2b \
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
    --tiers gemma4-e2b,gemma4-e4b \
    --data-path data/final
```

**Skip quantization** (faster iteration):

```bash
uv run --extra train python scripts/finetune_all_tiers.py \
    --tiers gemma4-e2b \
    --data-path data/final \
    --skip-quant
```

### Step 3: Evaluate

Evaluate a checkpoint:

```bash
uv run --extra train python scripts/eval_checkpoint.py \
    --checkpoint checkpoints/eliza-1-2b-v1/final \
    --registry-key gemma4-e2b \
    --val-jsonl data/final/val.jsonl \
    --out reports/eval-2b.json
```

Run the full benchmark suite vs Cerebras:

```bash
export CEREBRAS_API_KEY=...
uv run --extra train python scripts/benchmark_vs_cerebras.py \
    --tiers gemma4-e2b,gemma4-e4b \
    --benchmark all \
    --max-samples 500 \
    --output-dir reports/cerebras-comparison
```

### Step 4: Quantize

The quantization pipeline runs automatically inside `run_pipeline.py` and
`finetune_all_tiers.py`. The active Gemma release path emits GGUF q3/q4/q5/q6/q8
variants plus MTP metadata. Run the gated publish orchestrator for production
bundles; use the legacy sidecar recipes only for non-Gemma experiments.

For a local legacy sidecar experiment:

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
    --tiers gemma4-e2b,gemma4-e4b
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

**Active Gemma APOLLO budgets:**

| registry key | eliza tier  | base                | APOLLO peak budget | optimizer     |
|--------------|-------------|---------------------|--------------------|---------------|
| gemma4-e2b   | eliza-1-2b  | google/gemma-4-E2B  | ~15.5 GB           | apollo_mini   |
| gemma4-e4b   | eliza-1-4b  | google/gemma-4-E4B  | ~28 GB             | apollo_mini   |
| gemma4-12b   | eliza-1-9b  | google/gemma-4-12B  | ~80 GB             | apollo        |
| gemma4-31b   | eliza-1-27b | google/gemma-4-31B  | ~210 GB            | apollo_mini   |

**APOLLO variants:**

- `apollo_mini` (rank 1): Used for E2B and E4B. Rank-1
  projection — minimum optimizer state, good for tight GPU budgets.
- High-rank APOLLO (rank 512): Used for 12B (`apollo`) and 31B
  (`apollo_mini`). Higher rank = more accurate gradient approximation at the
  cost of more optimizer memory.

**Training always uses APOLLO.** The AGENTS.md contract is explicit: do not
swap to AdamW/Muon or any other optimizer without operator approval. The
release flow expects APOLLO-trained checkpoints.

---

## Per-Tier Requirements

| Tier         | GPU Memory | Seq Len | Est. Train Time (1 epoch) | Tier Type    |
|--------------|-----------|---------|--------------------------|--------------|
| gemma4-e2b   | 15.5 GB   | 8192    | ~3–4h (16 GB GPU)        | local        |
| gemma4-e4b   | 28 GB     | 8192    | ~4–6h (24–28 GB GPU)     | local        |
| gemma4-12b   | 80 GB     | 16384   | ~12–18h (H100 SXM)       | workstation  |
| gemma4-31b   | 210 GB    | 65536   | ~24–48h (2× H200/B200)   | cloud        |

Notes:
- Training time estimates assume full-corpus SFT, Liger fused CE, `--epochs 1`.
- The 27B tier uses the Gemma 4 31B base and requires FSDP across 2× H200/B200
  or 8× H100 — use `train_nebius.sh`
  or `train_vast.sh`. Set `ELIZA_FORCE_LOCAL_TRAIN=1` only on hardware that
  actually fits the 210 GB budget.
- Cap training with `--max-steps` when wall-clock matters:
  `--max-steps 1500` fits a 12h H200 budget at ~25 s/iter.
- Validate VRAM before running: `python scripts/training/memory_calc.py --shape <tier>`.

---

## Quantization: Gemma GGUF + MTP

Gemma 4 changes the release quantization shape. The active Eliza-1 tiers use
Gemma's MQA + windowed-SWA + shared-KV layout, so the old Qwen-era KV
compression stack is not a required release gate for Gemma. The publish path
still emits shippable GGUF flavors and MTP metadata for the fused runtime.

### Required for Gemma release bundles

- GGUF weight variants from the trained checkpoint: `gguf-q3_k_m`,
  `gguf-q4_k_m`, `gguf-q5_k_m`, `gguf-q6_k`, and `gguf-q8_0` as applicable
  for the target tier.
- MTP drafter metadata paired to the exact text checkpoint hash. Gemma 4 uses
  official separate draft models for speculative decoding; do not bundle a
  drafter whose target checkpoint hash does not match the shipped text GGUF.
- Kernel/eval manifests from the publish orchestrator. A bundle is not
  default-eligible until the manifest records passing text, voice, ASR, MTP,
  memory, and platform verification gates for the tier.

### Legacy / experimental recipes

`turboquant_apply.py`, `fused_turboquant_apply.py`, `polarquant_apply.py`, and
`qjl_apply.py` remain in the tree for legacy experiments and non-Gemma research.
They are not mandatory for Gemma 4 KV because Gemma's KV cache is already small
relative to the retired Qwen line. If you run them, their sidecar tests still
must pass before any artifact can be considered valid.

Verify registry KV metadata with a Gemma key:

```bash
python -c "from training.model_registry import get; e=get('gemma4-e2b'); print(e.infer_kv_layers)"
```

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
# Single local tier fallback on Nebius
REGISTRY_KEY=gemma4-e2b bash scripts/train_nebius.sh full

# With a step cap (fits 12h H200 budget)
REGISTRY_KEY=gemma4-12b MAX_STEPS=1500 bash scripts/train_nebius.sh full
```

For the 27B tier, Nebius only offers 1-GPU or 8-GPU presets. The 8-GPU preset
is expensive (~$240+/h). Prefer Vast for 27B:

```bash
# 27B on Nebius (confirm cost before running)
REGISTRY_KEY=gemma4-31b NEBIUS_VM_PRESET=gpu-h200x2 \
    FSDP_WORLD_SIZE=8 bash scripts/train_nebius.sh full
```

Generate Nebius manifests without submitting (for review):

```bash
uv run python scripts/finetune_all_tiers.py \
    --nebius \
    --tiers gemma4-e2b,gemma4-12b \
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
uv run python scripts/training/memory_calc.py --shape gemma4-12b
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
