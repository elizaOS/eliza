# Training optimizers — APOLLO

This directory owns the **optimizer side** of the local SFT pipeline.
Quantization (post-training) lives in `scripts/quantization/`; benchmarks in
`scripts/benchmark/`.

## What is APOLLO?

APOLLO ("Approximated Gradient Scaling for Memory-Efficient LLM Optimization",
Zhu et al., MLSys 2025 — arXiv:2412.05270) is the only optimizer exposed by
the eliza-1 local training entrypoints. It projects gradients into a low-rank
random subspace, applies an approximated channel- or tensor-wise scaling factor
back to the original gradient, and keeps the large matrix state compact. The
reference implementation ships as the `apollo-torch` PyPI package
(<https://github.com/zhuhanqing/APOLLO>, MIT-licensed).

We use APOLLO as the default optimizer because it lets us **full-fine-tune**
Qwen at sizes that would otherwise need LoRA on the same VRAM budget. LoRA
caps how much we can teach the model; APOLLO doesn't.

### Two recipes

| recipe       | rank | scale | scale_type | typical use |
|--------------|------|-------|------------|-------------|
| `apollo`      | 256  | 1     | channel    | default full APOLLO recipe |
| `apollo_mini` | 1    | 128   | tensor     | smallest state, slight perf cost |

Both apply only to **2-D weight matrices** (q/k/v/o/gate/up/down projections).
Embeddings, lm_head, biases, and RMSNorm weights stay in APOLLO's unprojected
parameter group.

## Recommended hyperparameters per eliza-1 size

These follow the APOLLO paper §5 and the LLaMA-Factory `examples/extras/apollo`
recipe. Authoritative per-model defaults live in `model_registry.py`
(CLI: `--registry-key`). The table here mirrors the registry and is regenerated
from it; if they disagree the registry wins.

| registry key     | optimizer    | rank | scale | micro_batch | grad_accum | seq_len | tier         |
|------------------|--------------|------|-------|-------------|------------|---------|--------------|
| `qwen3.5-2b`     | apollo_mini   | 256  | 128.0 | 1           | 16         | 8192    | local        |
| `qwen3.5-9b`     | apollo        | 512  | 1.0   | 2           | 8          | 16384   | workstation  |
| `qwen3.6-27b`    | apollo_mini   | 512  | 128.0 | 1           | 8          | 65536   | cloud (FSDP) |

`--apollo-update-proj-gap 200` is a reasonable default at every size. The
projector is re-randomized every 200 steps; lower it (50–100) for very short
runs (<1k steps) and raise it (400–500) for long pretraining-style schedules.

### Overriding `seq_len` per run

Registry `seq_len` values are *defaults*, not ceilings. Pass `--max-seq-len`
to `scripts/train_local.py` (and the same flag is forwarded by
`scripts/run_pipeline.py`) to override the registry default for one run:

```bash
# Long-context 27B experiment — registry default is 64k, push to 128k
# after validating with memory_calc.py first.
uv run --extra train python3 scripts/training/memory_calc.py \
    --shape qwen3.6-27b
uv run --extra train python3 scripts/train_local.py \
    --registry-key qwen3.6-27b \
    --max-seq-len 131072 \
    --full-finetune --epochs 1
```

The 27B default was lowered from 147k to 64k (gap M35) because the 147k
budget left only ~1% headroom on a 2× Blackwell 6000 cluster and ~6% on
2× H200 — one activation spike OOMed the run. 64k is the conservative
default; long-context runs are now an explicit per-run opt-in.

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

`--qlora` is rejected. This local pipeline is full-parameter APOLLO/APOLLO-Mini
only.

## Validation

`test_apollo.py` loads `Qwen/Qwen3.5-0.8B` on the local GPU, runs a single
training step with APOLLO and APOLLO-Mini on real records from
`data/final/train.jsonl`, and asserts that the APOLLO projector is active.

```bash
PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True \
    uv run --extra train python3 scripts/training/test_apollo.py
```

APOLLO-Mini must report less optimizer state than full APOLLO; otherwise the
rank-1 projector path is not engaged.
