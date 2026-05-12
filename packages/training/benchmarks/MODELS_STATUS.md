# Eliza-1 model tier status

Quick reference for what each `model_registry.py` tier is, where it can train,
and what command runs the SFT. Source of truth for tier geometry / budgets is
`scripts/training/model_registry.py`; this file is the operator-facing summary.

## Local tiers (16 GB consumer GPU, RTX 5080 Laptop class)

| registry key | published name | base | seq_len | train budget | runs locally? |
|---|---|---|---:|---:|---|
| `qwen3-0.6b` | `eliza-1-0_6b` | Qwen/Qwen3-0.6B | 4096 | 10 GB | yes (whole train→quant→bench stack < 1 h) |
| `qwen3-1.7b` | `eliza-1-1_7b` | Qwen/Qwen3-1.7B | 4096 | 15 GB | yes (drop seq to 2k if peak > 15 GB) |
| `qwen3-4b`   | `eliza-1-4b`   | Qwen/Qwen3-4B   | 4096 | 24 GB | needs a 24 GB card (4090 / A5000 / L4) |
| `qwen3.5-2b` | `eliza-1-2b`   | Qwen/Qwen3.5-2B | 8192 | 15.5 GB | yes (Liger required for the 8k window) |

Local SFT entrypoint (driven by `run_pipeline.py`, which calls `train_local.py`):

```bash
uv run python scripts/run_pipeline.py --registry-key qwen3-0.6b --epochs 3
# overridable knobs (0 = registry default):
#   --micro-batch 2 --grad-accum 4   # +20-40% samples/sec on the 0.6B at no quality cost
#   --max-seq-len 8192               # only after Liger is working; validate with memory_calc.py first
```

Throughput / context-scaling numbers: `benchmarks/THROUGHPUT.md`,
`packages/shared/src/local-inference/CONTEXT_SCALING.md`. APOLLO config audit
+ memory math: `benchmarks/APOLLO_TUNING.md`.

## Cloud tiers (9B / 27B — cannot train on a 16 GB laptop GPU)

These two tiers train against the next-gen Qwen3.5/3.6 dense checkpoints and
require datacenter GPUs. Full-parameter APOLLO + Liger SFT on a 16 GB consumer
card OOMs before the first step — do not attempt locally; use Vast (canonical)
or Nebius (deprecated fallback).

| registry key | published name | base | seq_len | train budget (world-aggregate) | GPU requirement |
|---|---|---|---:|---:|---|
| `qwen3.5-9b` | `eliza-1-9b` | Qwen/Qwen3.5-9B | 16384 | ~80 GB | 1× H200 SXM / A100-80 (single GPU, no FSDP needed) — or `blackwell6000-1x` (96 GB) on Vast |
| `qwen3.6-27b` | `eliza-1-27b` | Qwen/Qwen3.6-27B | 65536 | ~190 GB | 2× H200 SXM (FSDP) — or `b200-2x` (~366 GB) on Vast; single H200 OOMs even at seq 8k |

### Vast.ai (canonical)

`scripts/train_vast.sh` auto-picks the GPU target and FSDP world size from
`(PIPELINE, REGISTRY_KEY)`. One-shot provision + sync + train:

```bash
# eliza-1-9b (Qwen3.5-9B) — auto-selects blackwell6000-1x (96 GB, ~83% util at the 80 GB budget)
bash scripts/train_vast.sh provision-and-train --registry-key qwen3.5-9b --epochs 1 [--bootstrap rsync|hf]

# eliza-1-27b (Qwen3.6-27B) — auto-selects b200-2x (~366 GB, FSDP, ~52% util at the 190 GB budget)
bash scripts/train_vast.sh provision-and-train --registry-key qwen3.6-27b --epochs 1 [--bootstrap rsync|hf]
```

`--dry-run` prints the provision + sync + `accelerate launch train_local.py
--registry-key <key>` plan without spending Vast hours (cents locally, saved
several hundred $ of wasted hours during the 2026-05 smoke runs). The script's
`run` / `quantize` / `bench` / `fetch` subcommands run the post-training
quantize + base-vs-finetuned bench on the remote box and rsync the checkpoints
back. Budget cap: `ELIZA_VAST_MAX_USD` (warn) / 1.5× that (hard auto-teardown).

### Nebius (deprecated — emergency fallback only)

`scripts/train_nebius.sh` is kept for emergencies; do not extend it. It
provisions an H200 VM, syncs `training/`, and runs the same `train_local.py`
APOLLO SFT:

```bash
# eliza-1-27b on 2× H200 SXM (default preset gpu-h200x2)
REGISTRY_KEY=qwen3.6-27b bash scripts/train_nebius.sh full

# eliza-1-9b on a single H200 — halve the bill by switching the preset
REGISTRY_KEY=qwen3.5-9b NEBIUS_VM_PRESET=gpu-h200x1 bash scripts/train_nebius.sh full
```

Both cloud scripts call `scripts/train_local.py` directly under
`accelerate launch` for the FSDP launch (not `run_pipeline.py` — the pipeline
wrapper drives the local single-GPU stack and the corpus build; the cloud
scripts handle provisioning + sync + FSDP launch + remote quantize/bench
themselves). The model registry still drives `micro_batch` / `grad_accum` /
`seq_len` for the chosen `REGISTRY_KEY`.
