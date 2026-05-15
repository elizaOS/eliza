# DFlash Drafter Distillation on Nebius H200

This directory contains the scripts to run DFlash speculative-decode drafter
distillation on Nebius Cloud H200 GPU instances. All training runs on Nebius —
not locally. Local scripts only support `--synthetic-smoke` for CI/validation.

## What is Nebius

[Nebius Cloud](https://nebius.com) is a managed GPU cloud platform with access
to NVIDIA H200 SXM5 instances (141 GB HBM3e). It provides on-demand GPU
compute suitable for large-scale LLM training jobs without Kubernetes overhead.

## What is DFlash

DFlash is speculative decoding: a small distilled "drafter" model proposes N
tokens per step; the full target model verifies them in one forward pass.
Acceptance rate drives the speed-up. The drafter must be vocab-aligned to the
target (Qwen3.5-family, 248320-token vocabulary) and distilled from the exact
target checkpoint it ships with.

The required drafters are currently **INACTIVE** until each target has
a freshly distilled, vocab-aligned drafter. The `0_8b` tier is
intentionally DFlash-disabled: it ships no drafter and fails open to
normal target decoding because a same-size drafter has poor memory and
speedup economics.

## Tier mapping

| Target tier | DFlash policy | Student base |
|---|---|---|
| 0_8b | disabled, no drafter | n/a |
| 2b | required, 0.8B drafter | Qwen/Qwen3.5-0.8B-Base |
| 4b | required, 0.8B drafter | Qwen/Qwen3.5-0.8B-Base |
| 9b | required, 0.8B drafter | Qwen/Qwen3.5-0.8B-Base |
| 27b | required, 0.8B drafter | Qwen/Qwen3.5-0.8B-Base |
| 27b-256k | required, 0.8B drafter | Qwen/Qwen3.5-0.8B-Base |

## Recommended instance type

- **Type**: `gpu-h200-sxm` (NVIDIA H200 SXM5)
- **Memory**: 141 GB HBM3e per GPU
- **Region**: `eu-north1` or `us-east1` (check current availability)
- **OS image**: Ubuntu 22.04 + CUDA 12.4 base, or the NVIDIA NGC PyTorch container

For the 27b/27b-256k tiers, use a 2-GPU instance to fit both the
27B target and the 0.8B student in bf16 simultaneously.

## Container

```
nvcr.io/nvidia/pytorch:25.01-py3
```

This image ships with CUDA 12.4 and cuDNN 9. FlashAttention2 and
`apollo-torch` install cleanly on top of it (see `container_setup.sh`).

Alternatively, the plain Ubuntu image with `cuda-toolkit-12-4` works;
run `container_setup.sh` after provisioning.

## Cost note

H200 instances on Nebius: approximately $4/hr per GPU as of 2026-05.

Estimated wall times and cost per tier (1 GPU unless noted):

| Tier | Est. wall time | Est. cost |
|---|---|---|
| 0_8b | n/a | $0 |
| 2b | 8–10 h | ~$40 |
| 4b | 12 h | ~$48 |
| 9b | 24 h | ~$96 |
| 27b | 72 h (2 GPU) | ~$576 |
| 27b-256k | 72 h (2 GPU) | ~$576 |

Total for required tiers: budget **~$1,925** (single-pass, no retries).

## Quickstart

### 1. Launch an instance

Via the Nebius web console: <https://console.nebius.com>

Or via the Nebius CLI:

```bash
nebius compute instance create \
  --name dflash-h200-0 \
  --platform gpu-h200-sxm \
  --gpus 1 \
  --cores 32 \
  --memory 256GB \
  --disk-size 500GB \
  --image-family pytorch-25-01 \
  --zone eu-north1-a
```

For 27b/27b-256k, set `--gpus 2`.

### 2. Copy scripts to the instance

```bash
scp -r packages/training/scripts/dflash/ user@<instance-ip>:~/dflash/
```

### 3. Set up the environment

```bash
ssh user@<instance-ip>
bash ~/dflash/nebius/container_setup.sh
```

### 4. Validate the H200 environment

```bash
python ~/dflash/nebius/validate_h200_env.py
```

All checks must print PASS before proceeding.

### 5. Run all tiers

```bash
# Dry run first
bash ~/dflash/nebius/launch_all_tiers.sh --dry-run

# Real run (set required env vars first; 0_8b only writes policy evidence)
export TARGET_CHECKPOINT_ROOT=/data/checkpoints
export DATASET_ROOT=/data/distill-datasets
export OUTPUT_ROOT=/data/dflash-out
bash ~/dflash/nebius/launch_all_tiers.sh

# Recommended first required tier
bash ~/dflash/nebius/launch_all_tiers.sh --tiers 2b
```

### 6. Synthetic smoke (local, no GPU)

The smoke path exercises the full pipeline wiring without loading any models.
Run this locally before submitting real jobs:

```bash
bash packages/training/scripts/dflash/nebius/launch_all_tiers.sh \
    --synthetic-smoke
```

## Files in this directory

| File | Purpose |
|---|---|
| `container_setup.sh` | One-time container setup (pip installs, APOLLO, flash-attn) |
| `distill_drafter_h200.py` | H200-optimized core training script |
| `launch_all_tiers.sh` | Submit all 7 tiers sequentially (or subset via `--tiers`) |
| `validate_h200_env.py` | Pre-flight H200 environment check |
| `README.md` | This file |

## Output structure

Each tier writes to `<OUTPUT_ROOT>/<tier>-<timestamp>/`:

```

For `0_8b`, the output directory contains only:

```
0_8b-<timestamp>/
  dflash-disabled-0_8b.release-policy.json
  distill.log
```
<tier>-<timestamp>/
  drafter-<tier>.gguf          # distilled drafter GGUF (vocab-aligned)
  drafter-<tier>.distill.json  # run manifest (hashes, hyperparams, KL)
  checkpoint-500/              # intermediate HF checkpoint
  checkpoint-1000/
  ...
  checkpoint-final/            # final HF weights before GGUF conversion
  distill.log                  # full training log
```

After training, `validate_drafter.py` is invoked automatically to gate the
drafter against its acceptance-rate threshold before the output is considered
publish-eligible.

## Optimizer note

**APOLLO optimizer is mandatory.** No alternatives. Per project rule
(`CLAUDE.md`): "Training always uses APOLLO optimizer. No alternatives."
`distill_drafter_h200.py` imports `APOLLO` from `apollo-torch` and will
refuse to start with any other optimizer.
