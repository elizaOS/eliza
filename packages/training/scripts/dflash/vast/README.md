# DFlash Drafter Distillation on Vast.ai

This directory contains the provider-neutral Vast.ai launcher for Eliza-1
DFlash drafter jobs. It assumes you have already rented a GPU host, mounted or
copied the repo, and mounted the target checkpoints, GGUFs, and distillation
datasets.

Run a local dry run before copying commands to a GPU host:

```bash
bash packages/training/scripts/dflash/vast/launch_all_tiers.sh --dry-run
bash packages/training/scripts/dflash/vast/launch_all_tiers.sh --dry-run --tiers 2b,4b
```

Real run inside the Vast instance:

```bash
export TARGET_CHECKPOINT_ROOT=/data/checkpoints
export DATASET_ROOT=/data/distill-datasets
export TARGET_GGUF_ROOT=/data/eliza-1-final-gguf
export OUTPUT_ROOT=/data/dflash-out
bash packages/training/scripts/dflash/vast/launch_all_tiers.sh --tiers 2b
```

Policy matches `../release_policy.py`:

- `0_8b` writes fail-open no-drafter policy evidence and must not ship a
  `drafter-0_8b.gguf`.
- `2b`, `4b`, `9b`, `27b`, and `27b-256k` require real
  tokenizer-compatible drafters and fail closed during validation.
