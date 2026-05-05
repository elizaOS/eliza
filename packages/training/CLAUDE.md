# Eliza-1 Training & Inference — Agent Instructions

This directory holds the eliza-1 model line: training pipelines, quantization
sidecars, vLLM serving, and benchmarks. Read this file before touching anything
under `training/`. The layout, commands, and invariants here are load-bearing.

## What lives where

```
training/
  scripts/
    training/             SFT entrypoints, model registry, dataset packers,
                          run_pipeline.py orchestrator
    quantization/         PolarQuant / TurboQuant / QJL / FP8 / GGUF /
                          Heretic abliteration drivers + sidecar writers
    inference/            serve_vllm.py and per-GPU profile launchers
                          (h100 / h200 / blackwell)
    benchmark/            Benchmark runners that consume serve_vllm endpoints
    train_vast.sh         Canonical cloud entrypoint (Vast.ai)
    train_nebius.sh       DEPRECATED — see header banner; do not extend
    onstart-vllm.sh       Vast onstart — boots vLLM behind reverse proxy
  data/                   Packed / sharded JSONL datasets (~90 files,
                          train_final.jsonl ~18GB)
  checkpoints/            Local + cloud checkpoint outputs. Failed runs carry
                          a STATUS.md file and must not be consumed.
  benchmarks/             Per-checkpoint benchmark result dirs (one per
                          (model, quant, profile) tuple)
  RL_STRATEGY.md          DPO stage-1 → GRPO (verl) stage-2 plan. NOT YET
                          IMPLEMENTED. A parallel agent owns implementation.
  training-babylon/       EXPERIMENTAL research scaffold. Mock trajectories.
                          Not the canonical RL path. See its README banner.
```

The runtime resolver `eliza/packages/app-core/src/runtime/local-model-resolver.ts`
must stay in lockstep with `scripts/training/model_registry.py`. If you add or
rename a registry key, update the resolver in the same commit.

## Sizes and base models (model_registry.py)

| Registry key      | Eliza name   | Base model         | Cloud profile             |
| ----------------- | ------------ | ------------------ | ------------------------- |
| `qwen3.5-2b`      | eliza-1-2b   | Qwen/Qwen3.5-2B    | local 16GB OK             |
| `qwen3.5-9b`      | eliza-1-9b   | Qwen/Qwen3.5-9B    | 1× H200 SXM (~80 GB peak) |
| `qwen3.6-27b`     | eliza-1-27b  | Qwen/Qwen3.6-27B   | 2× H200 SXM, FSDP, 144k ctx |

## Optimization stack (currently wired)

### Training
- **APOLLO / APOLLO-Mini optimizer** — `apollo-torch>=1.0.3`. Default optimizer
  for full-finetune SFT. Memory-efficient SVD-projected updates.
- **Liger kernel** — chunked CE + fused RMSNorm + RoPE + SwiGLU. Auto-enabled
  when CUDA arch supports it.
- **Flash Attention 2 / 3** — auto-selected per GPU SM. FA3 on H100/H200/Blackwell.
- **Full-finetune** is the default. **LoRA** is local-fallback only when the
  GPU cannot fit a full pass.
- **bf16** mixed precision. **FSDP** for the 27B (sharded params + grads).

### Quantization (per-checkpoint sidecars)
- **PolarQuant** — 4-bit weight quant, vendored. Sidecars:
  `polarquant_artifacts.safetensors` + `polarquant_config.json`.
- **TurboQuant pure** — `turbokv` package. Sidecar: `turboquant.json`.
- **TurboQuant fused** — Triton kernels, vendored under
  `fused_turboquant_vendored/` with patches for Qwen3.5 gated-attn and
  partial-RoPE. Sidecar: `fused_turboquant.json`.
- **QJL** — 1-bit K-cache, vendored CUDA kernels patched for head_dim 128/256.
  Sidecar: `qjl_config.json`.
- **FP8** — `torchao.float8`. SM_90 / SM_100 only.
- **GGUF Q4_K_M / Q5_K_M / Q6_K** — produced via external llama.cpp.
- **Heretic abliteration** — AGPL-3.0. Sidecar: `abliteration_metadata.json`.
  See AGPL caveat below.

### Inference (serve_vllm.py)
- **vLLM v0.20+** with per-GPU launch profiles: `h100`, `h200`, `blackwell`.
- **DFlash** — z-lab fork of FlashAttention. Gated by `MILADY_VLLM_DFLASH=1`.
  Mutually exclusive with EAGLE-3 spec decoding.
- **EAGLE-3** spec decoding — mutually exclusive with DFlash.
- **Entropix logits processor** — entropy-aware sampling.
- **APC (Automatic Prefix Caching)** — gated by `MILADY_APC_DRAFTER_VERIFIED=1`
  because of upstream omlx#825. Do not enable APC by default until the safety
  gate flips. See "DO NOT" below.

## Canonical commands

Local end-to-end pipeline (SFT → quant sidecars → bench), 2B size:

```
uv run python scripts/run_pipeline.py --registry-key qwen3.5-2b
```

Cloud SFT on Vast.ai (canonical cloud — see DO NOT for Nebius):

```
bash scripts/train_vast.sh --registry-key qwen3.5-9b
bash scripts/train_vast.sh --registry-key qwen3.6-27b
```

Serve a checkpoint locally with the GPU profile detector:

```
python scripts/inference/serve_vllm.py \
  --checkpoint checkpoints/<run-id> \
  --profile h200
```

Run a benchmark suite against a running vLLM endpoint:

```
python scripts/benchmark/run.py --base-url http://localhost:8000 \
  --suite full --out benchmarks/<run-id>-h200/
```

## Sidecar JSON formats

Quant sidecars live next to the checkpoint they describe and are written by
the quantization script. Each sidecar is the contract between the training
side and the inference side — `serve_vllm.py` reads the sidecar to decide
which kernel path to load. Do not invent new fields; extend the writer in
`scripts/quantization/` and update the reader in `scripts/inference/` together.

- `turboquant.json` — pure TurboQuant config (block size, dtype, scheme).
- `fused_turboquant.json` — fused TurboQuant config (kernel variant,
  partial-RoPE flag, gated-attn flag, Triton autotune key).
- `polarquant_artifacts.safetensors` + `polarquant_config.json` — quantized
  weight tensors plus packing/scale metadata.
- `qjl_config.json` — QJL key-cache params (head_dim, projection seed,
  dequant scheme).
- `abliteration_metadata.json` — Heretic refusal-direction metadata, ablation
  layers, eval gate results. Required.

## Failed checkpoints

Failed runs are kept for forensic reference and carry a `STATUS.md` at the
checkpoint root. Do not load weights from any directory containing a
`STATUS.md` that says "FAILED RUN". Currently flagged:

- `checkpoints/qwen35-08b-smoke/`
- `checkpoints/qwen3-06b-eliza-toon-v2/`
- `checkpoints/qwen35-eliza-toon-v3/`

## Heretic / AGPL-3.0 (decided 2026-05-04)

The Heretic abliteration tool is AGPL-3.0. Decision: **accept it.**

- Milady source is MIT.
- Abliterated weight artifacts are distributed under AGPL-3.0 because they
  are derived from the Heretic transform. Mark them as such on the model
  card and in `abliteration_metadata.json` (`license: AGPL-3.0`).
- Non-abliterated eliza-1 variants ship under whatever license the underlying
  Qwen base mandates (Qwen-Research / Apache-2.0 depending on size); they
  are unaffected.
- The `serve_vllm.py` server itself remains MIT — serving an AGPL model file
  through it does not relicense the server, but downstream redistributors of
  the abliterated weights still get those weights under AGPL.
- Do not strip `abliteration_metadata.json` — provenance plus license must be
  preserved on every abliterated artifact on disk.

## DO NOT

- **Do not add a new optimization without a smoke test.** Every new optimizer,
  kernel, or quant scheme needs a smoke entry under `benchmarks/` proving it
  loads, generates tokens, and matches a perplexity sanity bound. No smoke
  test, no merge.
- **Do not bypass the abliteration eval gate.** `abliteration_metadata.json`
  must record the eval results AND `license: AGPL-3.0`; downstream tooling
  refuses to load if absent.

## Local smoke (`bun run training:smoke`)

`smoke_full_stack.sh` runs the full chain on Qwen3-0.6B (~5 GB VRAM, ~5 min
on RTX 5080+) end-to-end: SFT (200 steps) → bench → PolarQuant → bench →
fused-TQ → bench → QJL → bench → GGUF → vLLM serve → 5 tool-call probes →
acceptance gate. Every step is gated on toolchain availability and skips
cleanly when a dep is missing.

What the acceptance gate actually checks: `sft.content_ok ≥ 80%` (semantic
correctness — model picks the right action and RESPOND/IGNORE). It does
NOT gate on `format_ok` because 200 SFT steps cannot teach strict TOON
syntax — that's a job for the full 3-epoch production run, gated by the
publish pipeline (`push_model_to_hf.py`). The smoke's job is "the pipeline
runs and the model isn't generating gibberish," not "it would ship."

System headers (Python.h) needed for full coverage:
- Apt path: `sudo apt install python3.12-dev` enables Liger Triton kernels,
  fused-TurboQuant verify, and vLLM inductor compile (STEP 8). Without
  the headers the smoke auto-detects and skips those three steps.
- Container path: Docker/Vast `pytorch/pytorch:*-devel` images ship them.
  Vast SFT pipeline always runs the full chain.

QJL also wants `nvidia-cuda-toolkit` (nvcc); skipped when missing.
GGUF wants `llama-quantize` on PATH; skipped when missing.
- **Do not hardcode ports.** vLLM port comes from `--port` or env. Benchmark
  runners discover the URL; never embed `http://localhost:8000` in scripts.
- **Do not re-introduce Nebius.** Vast.ai is the canonical cloud. The
  `train_nebius.sh` script is kept as an emergency fallback only — do not
  extend it, do not add new Nebius features, do not document Nebius as an
  option in user-facing material.
- **Do not enable APC unless `MILADY_APC_DRAFTER_VERIFIED=1`.** Upstream
  issue omlx#825 makes APC unsafe with our drafter path until verified.
- **Do not consume a checkpoint that ships with a STATUS.md FAILED RUN file.**
- **Do not promote `training-babylon/` to the canonical RL path.** It is a
  research scaffold using mock trajectories. The canonical RL plan is
  `RL_STRATEGY.md` (DPO → verl GRPO), owned by a parallel implementation
  agent.
- **Do not edit `model_registry.py` without updating
  `eliza/packages/app-core/src/runtime/local-model-resolver.ts` in the same
  commit.** The two are a single contract.
