# Per-GPU specs and autotune math — single-GPU llama.cpp tier

Source of truth for the per-GPU JSON configs in this directory
(`3090.json`, `4090.json`, `5090.json`, `h200.json`) and for the
`gpu-autotune.ts` helper in `packages/app-core/src/services/local-inference/`.

Scope: **one GPU per host**. No tensor parallelism, no NVLink splits,
no multi-tenant scheduling. The product target is "one conversation at
a time on a single GPU box."

Inference engine: **llama.cpp / llama-server** (the buun-llama-cpp fork
that ships the QJL + Polar KV quant kernels). This file does not cover
vLLM / SGLang — those have different memory and parallelism models.

> All `expected_metrics` in the JSON configs are extrapolated, not
> measured. The `_provenance: "extrapolated"` field marks that explicitly.
> A real benchmark on each card replaces these once a runner is wired.

## Spec table

| Card | Arch (CC) | VRAM | Mem-BW | FP16 TFLOPs | FP8 TFLOPs | FP4 TFLOPs | INT4 TFLOPs | Max ctx (rec.) | Max parallel | Target RTF (voice) |
|---|---|---|---|---|---|---|---|---|---|---|
| **RTX 3090** | Ampere `sm_86` | 24 GiB GDDR6X | 936 GB/s | 71 | — | — | 284 | 65 536 | 4 | 0.55 |
| **RTX 4090** | Ada Lovelace `sm_89` | 24 GiB GDDR6X | 1 008 GB/s | 165 | 660 (E4M3/E5M2) | — | 660 | 131 072 | 8 | 0.40 |
| **RTX 5090** | Blackwell `sm_120` | 32 GiB GDDR7 | 1 792 GB/s | 209 | 838 | 1 676 | 838 | 262 144 | 12 | 0.30 |
| **H200 SXM** | Hopper `sm_90` | 141 GiB HBM3e | 4 800 GB/s | 989 | 1 979 | — | 1 979 | 1 048 576 | 16 | 0.20 |

RTF = real-time factor; lower is better. For voice streaming we need
RTF < 1 for steady-state and < 0.5 to leave headroom for TTS + ASR.

### Citations

- **RTX 3090** — NVIDIA Ampere GA102 whitepaper (2020). 24 GB GDDR6X
  at 19.5 Gbps × 384-bit = 936 GB/s. No FP8 tensor cores. Compute
  capability sm_86. flash-attn 2 supported; flash-attn 3 is Hopper-only.
- **RTX 4090** — NVIDIA Ada Lovelace AD102 whitepaper (2022). 24 GB
  GDDR6X at 21 Gbps × 384-bit = 1 008 GB/s. FP8 E4M3/E5M2 tensor cores
  (4th gen). Compute capability sm_89. flash-attn 2; flash-attn 3 kernels
  upstreamed but Hopper-tuned.
- **RTX 5090** — NVIDIA Blackwell GB202 whitepaper / launch deck (2025).
  32 GB GDDR7 at 28 Gbps × 512-bit = 1 792 GB/s. 5th-gen tensor cores
  with FP8 + FP4 (E2M1). Compute capability sm_120. llama.cpp sm_120
  kernel coverage is incomplete in early Blackwell builds — buun-llama-cpp
  records this in `CAPABILITIES.json`; the runtime probes it before
  promising QJL/Polar.
- **H200 SXM** — NVIDIA H200 datasheet (2024). 141 GB HBM3e at 4.8 TB/s.
  FP8 transformer engine (4th gen). Compute capability sm_90. Flash-attn 3
  first-class.

llama.cpp issues:
- Blackwell support tracking: <https://github.com/ggml-org/llama.cpp/issues/11279>
- KV cache quantization Q8/Q4: <https://github.com/ggml-org/llama.cpp/pull/7527>
- flash-attn-3 for Hopper: <https://github.com/ggml-org/llama.cpp/pull/13306>

## Autotune math

Two budgets dominate every choice:

1. **VRAM budget** — model weights + per-slot KV must fit.
2. **Memory bandwidth budget** — steady-state decode throughput is
   (weights-per-token) / (mem-bw). RTF ≈ tokens-per-second-audio /
   tokens-per-second-decode.

### KV-cache cost per token

Transformer KV cost: `bytes/token = 2 × n_layers × n_kv_heads × head_dim × bytes_per_element`
(factor of 2 = K and V).

Eliza-1 bundles (Qwen3.5 / 3.6 base):

| Bundle | n_layers | n_kv_heads | head_dim | FP16 KiB/tok | Q8K/Q4V KiB/tok | QJL+Polar KiB/tok |
|---|---|---|---|---|---|---|
| 0.8B / 2B class | 28 | 8 | 128 | 112 | 88 | 28 |
| 4B | 36 | 8 | 128 | 144 | 113 | 36 |
| 9B | 48 | 8 | 128 | 192 | 150 | 48 |
| 27B | 62 | 8 | 128 | 248 | 194 | 62 |

### Per-slot KV at recommended context

| Bundle | Ctx | KV quant | KV per slot |
|---|---|---|---|
| 2B | 32k | Q8K/Q4V | 32 768 × 88 KiB = **2.75 GiB** |
| 2B | 32k | QJL+Polar | 32 768 × 28 KiB = **0.88 GiB** |
| 9B | 65k | QJL+Polar | 65 536 × 48 KiB = **3.0 GiB** |
| 27B | 32k | QJL+Polar | 32 768 × 62 KiB = **2.0 GiB** |
| 27B | 128k | QJL+Polar | 131 072 × 62 KiB = **8.0 GiB** |
| 27B | 256k | QJL+Polar | 262 144 × 62 KiB = **16.0 GiB** |
| 27B | 1M | QJL+Polar | 1 048 576 × 62 KiB = **64.0 GiB** |

### Parallel slot derivation

VRAM available for KV ≈ `vram - model_weights - reserved_headroom`.
Reserved headroom (driver + activations + drafter): 3 GiB on 24 GB
cards, 4 GiB on 5090, 6 GiB on H200. See `reservedHeadroomGb()` in
`packages/shared/src/local-inference/gpu-profiles.ts`.

**RTX 3090 (24 GiB, no FP8)** — uses Q8K / Q4V KV (Ampere has no q4_polar
kernel on the Polar fork).

- 2B (1.5 GiB model): KV budget 19.5 GiB / 2.75 GiB-per-slot = **7 max
  parallel @ 32k**. Config caps at 8 to leave OS-window headroom.
- 9B (5.4 GiB): KV budget 15.6 GiB / (65 536 × 150 KiB = 9.4 GiB-per-slot
  @ 64k) = 1 parallel @ 64k; at 32k it's 4.7 GiB-per-slot → **3 parallel**.
  Config picks 4 with kvSpillToCpu opt-in at 64k.
- 27B (16.8 GiB): KV budget 4.2 GiB / 2 GiB-per-slot @ 32k = **2 parallel**.

**RTX 4090 (24 GiB, FP8)** — QJL + Polar KV available.

- 2B: KV budget 19.5 GiB / 0.88 GiB-per-slot @ 32k = **16 parallel**
  (we cap at 16 for practical session-count reasons).
- 9B: 18 GiB / 3 GiB-per-slot @ 64k = 6; spec picks **8 parallel @ 32k**
  (slot KV = 1.5 GiB) for voice; 4 @ 64k for chat.
- 27B: 4.2 GiB / 2 GiB-per-slot @ 32k = **2 parallel**.
- voice (omnivoice + small LLM): omnivoice runs on CPU/Metal in fused
  mode; KV is only the small text drafter. Cap **4 parallel** at 8k for
  the voice loop.

**RTX 5090 (32 GiB, FP8/FP4)** — same KV math, 8 GiB more headroom.

- 2B: KV budget 27.5 GiB / 0.88 GiB = 31 → **24 parallel** (we leave
  realistic session headroom).
- 9B: 26.6 GiB / 3 GiB @ 64k = 8 → **12 parallel @ 64k**.
- 27B: 12 GiB / 2 GiB @ 32k = 6 → **6 parallel @ 32k**; at 128k it's
  8 GiB per slot → 1.5 → **1 parallel @ 128k**.
- 27b-256k: ~16 GiB per slot → 0 parallel headroom; **1 parallel** with
  `kvSpillToCpu` opt-in.

**H200 (141 GiB)** — the marquee box.

- 27b-1m: 64 GiB KV per slot. 141 - 17 (model) - 6 (reserved) = 118 GiB
  free → 1 full + 0.84 partial → **2 parallel @ 1M** (the second slot
  shares prefix-cache space via radix).
- 27b-256k: 16 GiB per slot → **6 parallel**.
- 27b: 2 GiB per slot @ 32k → **16 parallel** (capped).
- 9b: ~0.45 GiB per slot @ 8k → **64 parallel**.

### Batch / ubatch derivation

- `batch_size` = logical batch fed to the prefill kernel per server tick.
  Doubles with VRAM (more headroom for activations) but caps at 4096 —
  beyond that, llama.cpp scheduler overhead eats the win.
- `ubatch_size` = physical micro-batch the GPU launches. Ada / Blackwell
  / Hopper want `≥ 512` to keep tensor cores saturated; Ampere is
  happiest at 256-512.

| Card | batch | ubatch | Why |
|---|---|---|---|
| 3090 | 2048 | 512 | Ampere; mem-bw-bound past 512 ubatch |
| 4090 | 2048 | 512 | Same dies as 3090 family; FP8 helps prompt eval not decode |
| 5090 | 4096 | 1024 | More SMs + GDDR7 bw lets the bigger ubatch land |
| H200 | 4096 | 2048 | HBM3e + sm_90 tensor cores; bigger ubatch wins |

### `n_gpu_layers`

Always **999** (all layers on GPU). Single-GPU only — we never split
across cards in this tier. The literal `-1` works equally well in
llama.cpp but `999` is unambiguous and survives clamping in older builds.

### `split_mode` / `main_gpu`

Always `"none"` / `0`. We never multi-GPU.

### `cache_type_k` / `cache_type_v`

- **Ampere (3090)**: `q8_0` / `q4_polar`. The q4_polar Polar-quant V
  kernel exists for sm_86 but the qjl1_256 K kernel does not — fall back
  to Q8 K.
- **Ada / Blackwell / Hopper (4090 / 5090 / H200)**: `qjl1_256` / `q4_polar`.
  Both kernels are pre-built and exposed in `CAPABILITIES.json`.

### `ctx_checkpoints` / `ctx_checkpoint_interval`

Used by the voice optimistic-rollback path. Mid-prefill snapshots cost
~per-checkpoint = `slot_kv_at_checkpoint`. Defaults per
`ctxCheckpointsForTier()` in `packages/shared/src/local-inference/catalog.ts`:

| Bundle | ctx_checkpoints | interval |
|---|---|---|
| 0.8B / 2B | 4 | 4 096 |
| 4B / 9B | 8 | 8 192 |
| 27B (incl. 256k / 1m) | 16 | 8 192 |

### DFlash draft range

Per-card, picked from `dflashDraftMin` / `dflashDraftMax` in `gpu-profiles.ts`:

| Card | min | max |
|---|---|---|
| 3090 | 4 | 16 |
| 4090 | 4 | 24 |
| 5090 | 4 | 24 |
| H200 | 8 | 32 |

Draft window scales with compute throughput, not memory. Bigger cards
can verify a longer drafter run per round without latency hit.

### `p_min` / `draft_p_min`

`0.5` everywhere — drafter token accepted only if `p ≥ 0.5`. This is a
conservative default for voice latency. Higher values mean fewer
accepted drafts; lower values raise rollback waste.

## Known limits

- **3090 has no FP8** — 27B quality drops slightly without FP8
  attention; we keep Q8K KV for safety. Don't promise FP8 on `sm_86`.
- **5090 sm_120 kernel coverage** — early Blackwell llama.cpp builds may
  not ship `qjl1_256` for sm_120. The runtime probes
  `CAPABILITIES.json`; missing → fall back to `q8_0`/`q4_0` and surface
  a structured warning rather than silently. Don't fix in the autotune;
  fix in the kernel build.
- **flash-attn-3** — Hopper only (sm_90). 4090 / 5090 use flash-attn-2.
- **24 GiB cards at 27B + ≥64k ctx** — fits only with QJL+Polar AND
  single slot AND `--mlock`. Beyond 64k, opt-in `kvSpillToCpu=true`.
- **H200 1M @ 2 parallel** — radix cache helps when sessions share a
  long system prefix; otherwise the second slot will OOM on a fresh
  conversation. Production deployments should plan for one full-context
  session per card.

## Override mechanism

The autotune helper merges in this order (later wins):

1. `gpu-profiles.ts` static profile defaults
2. `packages/inference/configs/gpu/<id>.json` (this directory)
3. Bundle-specific override block (`bundle_recommendations.<bundle>`)
4. Per-call `overrides` arg to `selectGpuConfig()` (used by the CLI)
5. Env vars: `ELIZA_LOCAL_*` (see `dflash-server.ts` for the full list,
   e.g. `ELIZA_LOCAL_UBATCH_SIZE`, `ELIZA_LOCAL_N_PARALLEL`).

When `selectGpuConfig()` gets a GPU it doesn't recognize, it falls back
on a VRAM bucket:

| VRAM (GiB) | Bucket | Falls back to |
|---|---|---|
| < 12 | tiny | Returns `null` — use catalog defaults |
| 12 – 18 | small | RTX 3090 profile, parallel halved |
| 18 – 28 | mid | RTX 3090 |
| 28 – 40 | mid-plus | RTX 5090 (capped) |
| 40 – 80 | large | RTX 5090 |
| ≥ 80 | huge | H200 |

Bucket fallback is "best effort" — if the user has an unsupported card,
log the fallback choice loudly so they know they're not on a tuned
profile.
