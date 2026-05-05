# Qwen Capacity Runbook

Use the capacity planner before changing local or Nebius training recipes.

## What It Answers

- Chinchilla token budget using total parameters
- Chinchilla token budget using active parameters for sparse MoE models
- Approximate training memory for:
  - full-parameter AdamW
  - full-parameter APOLLO
  - bf16 LoRA adapters
  - QLoRA / NF4 adapters
- Approximate long-context KV-cache memory for bf16 and TurboQuant-style compressed KV
- Single-GPU fit checks for Nebius `h100` and `h200` VM shapes

## Canonical Entrypoint

```bash
cd /Users/shawwalters/babylon-workspace/babylon/packages/training/python
python3 scripts/plan_qwen_training.py --format markdown
```

## Examples

Plan the current 9B paper track:

```bash
python3 scripts/plan_qwen_training.py \
  --model 9b \
  --contexts 128k,256k \
  --training-seq-length 8192 \
  --format markdown
```

Inspect the sparse 122B planning range:

```bash
python3 scripts/plan_qwen_training.py \
  --model 122b \
  --contexts 128k,256k \
  --training-seq-length 8192 \
  --format json
```

## Interpretation Notes

- The APOLLO estimates are optimizer-memory estimates, not a guarantee that a full run will be stable.
- The 122B sparse model should be planned with both total-parameter and active-parameter budgets visible. Do not collapse that to one number.
- TurboQuant in this runbook is treated as a KV-cache compression factor for serving and benchmark planning. It is not treated as a trainer-side optimization.
- The context-memory numbers are KV-cache estimates for the full-attention layers in the hybrid Qwen 3.5 stack. They are most useful for long-context serving and benchmark planning.

## Nebius VM Runner

The Nebius unified matrix runner now uses the canonical Qwen registry and rejects known single-GPU configurations that do not fit the requested H100/H200 target:

```bash
python3 scripts/run_nebius_unified_matrix.py \
  --base-model Qwen/Qwen3.5-9B \
  --gpu-type h200 \
  --dry-run
```

Current limit:

- `Qwen/Qwen3.5-122B-A10B` is intentionally rejected by the single-VM Nebius runner. That model needs a cluster-oriented path, not the VM matrix helper.

## Local CUDA Trainer

The local CUDA trainer now writes a planner artifact at `training_capacity_report.json` for canonical Qwen 3.5 models and performs the same single-GPU fit check before training starts.

Example QLoRA run:

```bash
python3 scripts/train_local.py \
  --backend cuda \
  --model Qwen/Qwen3.5-4B \
  --source-dir /path/to/export \
  --optimizer adamw \
  --quantization nf4 \
  --lora \
  --lora-rank 32 \
  --max-seq-length 4096 \
  --output ./trained_models/qwen35-4b-qlora
```
