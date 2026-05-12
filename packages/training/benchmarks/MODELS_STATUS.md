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

## Measured — model geometry, run status, throughput (RTX 5080 Laptop 16 GB, sm_120, CUDA 13; 2026-05-11)

### Base-model geometry (all six published on HF; the `elizaos/eliza-1-*` repos do **not** exist yet — the runtime catalog placeholders re-host upstream Qwen3-GGUF)

| tier | base | arch | layers | n_heads / n_kv | head_dim | hidden | vocab | max_pos | notes |
|---|---|---|---:|---|---:|---:|---:|---:|---|
| `eliza-1-0_6b` | Qwen3-0.6B | qwen3 | 28 | 16 / 8 | 128 | 1024 | 151 936 | 40 960 | smallest; full SFT fits 16 GB at seq 4096 |
| `eliza-1-1_7b` | Qwen3-1.7B | qwen3 | 28 | 16 / 8 | 128 | 2048 | 151 936 | 40 960 | SFT fits 16 GB at **seq ≤ 2048** without Liger (seq 4096 OOMs on the CE step) |
| `eliza-1-4b`  | Qwen3-4B  | qwen3 | 36 | 32 / 8 | 128 | 2560 | 151 936 | 40 960 | needs ~24 GB for full SFT; calibration fits 16 GB |
| `eliza-1-2b`  | Qwen3.5-2B | **qwen3_5 (VLM)** | text 24 | 8 / 2 | 256 | 2048 | 248 320 | 262 144 | **hybrid linear-attention** (`full_attention_interval=4` — 3:1 linear:full); 248k vocab → big CE transient; needs Liger or a very short seq for SFT |
| `eliza-1-9b`  | Qwen3.5-9B | qwen3_5 | text 32 | 16 / 4 | 256 | 4096 | 248 320 | — | cloud only (see above) |
| `eliza-1-27b` | Qwen3.6-27B | qwen3_6 | text 64 | 24 / 4 | 256 | 5120 | 248 320 | — | cloud only (see above) |

### Run status

| tier | SFT | GGUF | eliza1-bundle (polarquant+qjl+turboquant) | bench (CUDA, `-fa 1 -b 2048 -ngl 99`) |
|---|---|---|---|---|
| `eliza-1-0_6b` | ✅ APOLLO `apollo_mini` full-param, 8000 samples / 1 epoch, eval_loss 1.315 (`checkpoints/eliza-1-0_6b-apollo-1778551769/final/`) | ✅ Q4_K_M, 396 MB | ✅ sidecars applied (`polarquant_artifacts.safetensors` + `qjl_config.json` + `turboquant.json` + `eliza1_manifest.json`); GGUF body is **Q8_0**, not native `Q4_POLAR` — `weight_quant.deferred: true` (the fork's `convert_hf_to_gguf.py` doesn't emit `q4_polar` yet; runtime kernels exist) | Q4_K_M: ~27.8 k pp512 / ~384 tg128 @ d0, ~6.6 k pp / ~125 tg @ d16k. eliza1-bundle Q8_0: ~31 k pp512 / ~392 tg128 @ d0 |
| `eliza-1-1_7b` | 🔄 in progress — seq 4096 OOM'd on the cross-entropy step (16 GB, no Liger, 152k-vocab logits transient); re-running at **`--max-seq-len 2048`** (fits, ~15.3 GB peak) | pending | pending | pending |
| `eliza-1-4b`  | pending — will try full SFT (expect OOM at seq 4096 on 16 GB → fall back to: download Qwen3-4B → Q4_K_M GGUF → bench + run the quant-chain *calibration* forward passes which do fit 16 GB) | pending | pending | pending |
| `eliza-1-2b`  | pending — qwen3_5 VLM + hybrid linear-attn; needs the qwen3_5 model class loadable + Liger (248k vocab) or a tiny seq for SFT; will try `--max-samples 1000 --max-seq-len 1024` | pending | pending | pending |
| `eliza-1-9b` / `eliza-1-27b` | cloud only — `bash scripts/train_vast.sh provision-and-train --registry-key qwen3.5-9b` / `--registry-key qwen3.6-27b` | — | — | — |

### Optimization-applicability per tier

- **Flash attention** (`-fa 1`, `optimizations.flashAttention: true` in `catalog.ts runtimeFor()`) — all tiers. +25 % prefill.
- **PolarQuant Q4_POLAR weights** (4.25 bpw) — produced as a sidecar for every locally-built tier; *baked into the GGUF* once the fork's converter emits `q4_polar` (currently deferred → q8_0 fallback, honestly recorded).
- **QJL1_256 K-cache + TBQ3_0/TBQ4_0 V-cache** — catalog default for any context > 8 k; the fork's CUDA `fattn-vec-instance-{tbq3_0,tbq4_0}.cu` kernels implement the TBQ side; the standalone `qjl_*` kernels implement the K side (not yet a `fattn-vec` instance — punch-listed). `llama-cli`/`llama-server` accept `--cache-type-{k,v} tbq3_0|tbq4_0`; `llama-cli` does **not** accept `qjl1_256` (only `llama-server` does), and `llama-bench` accepts neither — so QJL K-cache throughput is measured via the inference team's e2e/kernel benches, not `llama-bench`.
- **DFlash speculative decode** — wired in `catalog.ts` for 1.7b+ (drafter `Qwen/Qwen3-0.6B` for 1.7b/4b, `Qwen/Qwen3-1.7B` for 9b/27b); ≈ 2–3× gen for the big tiers once a drafter is distilled (`scripts/distill_dflash_drafter.py`). The 0.6b gets no drafter (no smaller-than-itself Qwen3 base).
- **APOLLO** (`apollo_mini` rank-1 for all but 9b which is full `apollo` rank-512) — the optimizer that makes 0.6b/1.7b full-param SFT fit a consumer GPU. Liger (FLCE chunked CE) is the thing that would let 1.7b SFT at seq 4096 / 2b at seq 8192 on 16 GB — currently broken (Triton can't JIT without `python3.12-dev`); `train_local.py` probes and falls back to HF defaults instead of crashing.
