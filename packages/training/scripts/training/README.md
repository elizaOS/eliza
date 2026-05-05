# Training optimizers — APOLLO

This directory owns the **optimizer side** of the local SFT pipeline.
Quantization (post-training) lives in `scripts/quantization/`; benchmarks in
`scripts/benchmark/`.

## What is APOLLO?

APOLLO ("Approximated Gradient Scaling for Memory-Efficient LLM Optimization",
Zhu et al., MLSys 2025 — arXiv:2412.05270) is a drop-in replacement for AdamW
that gives **SGD-like optimizer-state memory with AdamW-level convergence**.
It works by projecting gradients into a low-rank random subspace, running the
Adam moment updates in that subspace, then applying an approximated channel-
or tensor-wise scaling factor back to the original gradient. Because the moment
buffers (`exp_avg`, `exp_avg_sq`) live in the projected space, the optimizer
state shrinks roughly with the projection rank. The reference implementation
ships as the `apollo-torch` PyPI package
(<https://github.com/zhuhanqing/APOLLO>, MIT-licensed).

We use APOLLO as the default optimizer because it lets us **full-fine-tune**
Qwen at sizes that would otherwise need LoRA on the same VRAM budget. LoRA
caps how much we can teach the model; APOLLO doesn't.

### Two recipes

| recipe       | rank | scale | scale_type | typical use |
|--------------|------|-------|------------|-------------|
| `apollo`      | 256  | 1     | channel    | default — closest to AdamW perf |
| `apollo_mini` | 1    | 128   | tensor     | smallest state, slight perf cost |

Both apply only to **2-D weight matrices** (q/k/v/o/gate/up/down projections).
Embeddings, lm_head, biases, and RMSNorm weights stay on plain AdamW (per
the reference recipe — projecting them is either useless or harmful).

## Recommended hyperparameters per eliza-1 size

These follow the APOLLO paper §5 and the LLaMA-Factory `examples/extras/apollo`
recipe. Authoritative per-model defaults live in `model_registry.py`
(CLI: `--registry-key`). The table here mirrors the registry and is regenerated
from it; if they disagree the registry wins.

| registry key     | optimizer    | rank | scale | micro_batch | grad_accum | seq_len | tier         |
|------------------|--------------|------|-------|-------------|------------|---------|--------------|
| `qwen3.5-2b`     | apollo_mini   | 256  | 128.0 | 1           | 16         | 8192    | local        |
| `qwen3.5-9b`     | apollo        | 512  | 1.0   | 2           | 8          | 16384   | workstation  |
| `qwen3.6-27b`    | apollo_mini   | 512  | 128.0 | 1           | 8          | 147456  | cloud (FSDP) |

`--apollo-update-proj-gap 200` is a reasonable default at every size. The
projector is re-randomized every 200 steps; lower it (50–100) for very short
runs (<1k steps) and raise it (400–500) for long pretraining-style schedules.

## CLI — launching SFT with APOLLO

The simplest way is to use the model registry key — it pulls batch size,
gradient accumulation, sequence length, optimizer rank, and memory budget
from `model_registry.py`:

```bash
uv run --extra train python3 scripts/train_local.py \
    --registry-key qwen3.5-2b \
    --full-finetune --epochs 3 --lr 2e-5 \
    --run-name qwen35-2b-apollo-v1
```

Or pass everything by hand:

```bash
uv run --extra train python3 scripts/train_local.py \
    --model Qwen/Qwen3.5-2B \
    --full-finetune \
    --epochs 3 --batch-size 1 --grad-accum 16 \
    --lr 2e-5 --max-seq-len 2048 \
    --run-name qwen35-2b-apollo-v1
```

To run APOLLO-Mini (smallest optimizer state — used for the local-tier 2B and the cloud-tier 27B at long sequence lengths):

```bash
uv run --extra train python3 scripts/train_local.py \
    --model Qwen/Qwen3.5-2B \
    --full-finetune --optimizer apollo_mini \
    --epochs 3 --batch-size 4 --grad-accum 8 \
    --lr 2e-5 --max-seq-len 4096 \
    --run-name qwen35-2b-apollo-mini-v1
```

To compare against vanilla AdamW (still LoRA-friendly):

```bash
uv run --extra train python3 scripts/train_local.py \
    --optimizer adamw \
    --epochs 3 --batch-size 4 --grad-accum 8 \
    --lr 2e-4 \
    --run-name qwen35-2b-adamw-baseline
```

`--qlora` is rejected with `--optimizer apollo*` (4-bit base + low-rank
projector double-claim the matrix space). Use AdamW if you want QLoRA.

## Validation

`test_apollo.py` loads `Qwen/Qwen3.5-0.8B` on the local GPU, runs a single
training step with each of {AdamW, APOLLO, APOLLO-Mini} on real records from
`data/final/train.jsonl`, and asserts that APOLLO's optimizer-state memory and
peak VRAM are both materially smaller than AdamW's.

```bash
PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True \
    uv run --extra train python3 scripts/training/test_apollo.py
```

Measured on RTX 5080 Laptop, 16 GB, batch=1 seq=128, Qwen3.5-0.8B in bf16:

| optimizer     | peak VRAM (MiB) | step (s) | opt-state (MiB) | bytes / param |
|---------------|-----------------|----------|-----------------|---------------|
| AdamW          | 7252.4           | 1.04      | 2870.15           | 4.00           |
| APOLLO         | 4887.1           | 0.55      | 1487.90           | 2.07           |
| APOLLO-Mini    | 4887.1           | 0.52      |  973.92           | 1.36           |

APOLLO saves 48% of optimizer-state and 33% of peak VRAM vs AdamW even on a
0.8B model where the (un-projected) lm_head + embeddings dominate. Savings
grow to the paper's reported >75% on 7B+ models.
