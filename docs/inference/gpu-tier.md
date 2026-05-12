# Single-GPU tier — llama.cpp deployment

This tier targets **one NVIDIA GPU per host** with `llama-server`
(buun-llama-cpp fork). It is not vLLM and it is not multi-GPU.

Per-GPU autotune profiles, the bundle matrix, and the spec math live in
[`packages/inference/configs/gpu/SPECS.md`](../../packages/inference/configs/gpu/SPECS.md).
The autotune helper that resolves a detected GPU into a `llama-server`
flag set lives at
[`packages/app-core/src/services/local-inference/gpu-autotune.ts`](../../packages/app-core/src/services/local-inference/gpu-autotune.ts).

## Supported GPUs

| Card | Arch | VRAM | Mem-BW | FP8 | FP4 | Flash-attn-3 |
|---|---|---|---|---|---|---|
| RTX 3090 | Ampere `sm_86` | 24 GiB | 936 GB/s | no | no | no |
| RTX 4090 | Ada Lovelace `sm_89` | 24 GiB | 1 008 GB/s | yes | no | no |
| RTX 5090 | Blackwell `sm_120` | 32 GiB | 1 792 GB/s | yes | yes | yes |
| H200 SXM | Hopper `sm_90` | 141 GiB | 4 800 GB/s | yes | no | yes |

## Expected RTF + TTFA per (GPU, bundle)

All values are **extrapolated from VRAM + mem-bandwidth math** until a
real bench run replaces them (`expected_metrics._provenance:
"extrapolated"` in every JSON config until that happens). Concretely
that means: no SLA, no GA-blocking commitments are derived from these
numbers — they exist so the autotune helper can sort candidate configs
by predicted RTF and so engineers know what range to expect.

| GPU | Bundle | Ctx | TTFA p50 (ms) | TTFA p95 (ms) | RTF | Decode tok/s |
|---|---|---|---|---|---|---|
| RTX 3090 | text-1.7b / eliza-1-2b | 32k | 320 | 500 | 0.55 | 95 |
| RTX 3090 | eliza-1-9b | 65k | 400 | 600 | 0.6 | 70 |
| RTX 3090 | eliza-1-27b | 16k | 600 | 900 | 0.85 | 35 |
| RTX 4090 | text-1.7b / eliza-1-2b | 65k | 220 | 320 | 0.4 | 140 |
| RTX 4090 | eliza-1-9b | 65k | 280 | 400 | 0.45 | 110 |
| RTX 4090 | eliza-1-27b | 32k | 450 | 700 | 0.55 | 60 |
| RTX 5090 | eliza-1-9b | 128k | 200 | 300 | 0.3 | 180 |
| RTX 5090 | eliza-1-27b | 64k | 320 | 500 | 0.4 | 95 |
| RTX 5090 | eliza-1-27b-256k | 256k | 600 | 900 | 0.5 | 75 |
| H200 | eliza-1-9b | 1M | 150 | 240 | 0.25 | 270 |
| H200 | eliza-1-27b-256k | 256k | 220 | 330 | 0.25 | 200 |
| H200 | eliza-1-27b-1m | 1M | 400 | 600 | 0.3 | 120 |

RTF = real-time factor for voice; lower is better. RTF < 0.5 leaves
headroom for ASR + TTS in the streaming voice loop.

## Override mechanism

Resolution order (later wins):

1. `GPU_PROFILES[id]` static defaults from
   [`packages/shared/src/local-inference/gpu-profiles.ts`](../../packages/shared/src/local-inference/gpu-profiles.ts).
2. JSON config at `packages/inference/configs/gpu/<gpu>.json`.
3. Bundle-specific block (`bundle_recommendations.<bundle>`) in the
   same JSON file.
4. Per-call `overrides` argument to `selectGpuConfig()`.
5. Environment variables read at spawn time by `dflash-server.ts`,
   e.g. `ELIZA_LOCAL_UBATCH_SIZE`, `ELIZA_LOCAL_N_PARALLEL`,
   `ELIZA_LOCAL_BATCH_SIZE`.

When `nvidia-smi --query-gpu=name` returns a card we don't have a tuned
profile for, `selectGpuConfig()` falls back on a VRAM bucket:

| VRAM (GiB) | Bucket | Falls back to | parallel scale |
|---|---|---|---|
| < 12 | tiny | none — uses catalog defaults | — |
| 12 – 18 | small | RTX 3090 profile | × 0.5 |
| 18 – 28 | mid | RTX 3090 | × 1.0 |
| 28 – 40 | mid-plus | RTX 5090 (capped) | × 0.5 |
| 40 – 80 | large | RTX 5090 | × 1.0 |
| ≥ 80 | huge | H200 | × 1.0 |

Bucket fallbacks log a structured warning. If you see one in production,
file an issue and we'll add a tuned profile.

## Per-GPU known limits

### RTX 3090 (Ampere `sm_86`)

- No FP8 tensor cores → text-27B quality drops slightly vs Ada/Blackwell.
- No FP4.
- flash-attn-3 not supported (Hopper-only kernel).
- `qjl1_256` K kernel not built for `sm_86` — falls back to `q8_0` for K.
- 27B + ctx ≥ 32k requires single slot and is tight on 24 GiB.

### RTX 4090 (Ada Lovelace `sm_89`)

- FP8 (E4M3 + E5M2) tensor cores, but flash-attn-2 only (no flash-attn-3).
- No FP4.
- 27B + 32k context is single-slot only on 24 GiB.

### RTX 5090 (Blackwell `sm_120`)

- FP8 + FP4 tensor cores; flash-attn-3 supported.
- sm_120 kernel coverage in llama.cpp is early. The runtime probes
  `CAPABILITIES.json` before promising QJL + Polar; missing kernels
  fall back to Q8/Q4 with a structured warning.
- 27B-256k is single-slot only and requires `kvSpillToCpu` opt-in.

### H200 SXM (Hopper `sm_90`)

- FP4 not supported (Blackwell-only).
- 27B-1M at `parallel > 2` requires prefix sharing via radix cache.
  Production deployments should plan for one full-context session per
  card.
- PCIe spill defeats the bandwidth advantage; keep KV in HBM.

## One-command voice-bench

Print the resolved autotune plan for the host GPU (no model load, no
benchmark run — safe on a CPU-only host):

```bash
bun run --cwd packages/inference/voice-bench bench gpu
bun run --cwd packages/inference/voice-bench bench gpu --bundle eliza-1-9b
```

Once the cuda `PipelineDriver` lands (currently mock-only — see the
voice-bench README "Wiring the real pipeline" section), running the
full bench with the autotune plan looks like:

```bash
bun run --cwd packages/inference/voice-bench bench \
  --bundle eliza-1-9b --backend cuda --scenario all --runs 5 \
  --output bench-$(hostname)-$(date +%Y%m%d).json
```

## CI

The nightly GPU bench workflow is stubbed at
[`.github/workflows/gpu-bench-nightly.yml`](../../.github/workflows/gpu-bench-nightly.yml).
It is gated `if: false` until a self-hosted CUDA runner is wired (L4 is
the cheapest GPU runner target). When enabled, it runs the voice-bench
matrix on a per-card basis and uploads the result JSON for regression
gating.
