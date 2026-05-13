# Eliza-1 GPU Deployment Profiles

Single-GPU deployment configs for the Eliza-1 line on NVIDIA cards.

**Scope (read first):**

- **Single GPU per host.** No NVLink, no tensor-parallel splits, no
  pipeline parallelism. One card holds the whole model.
- **One conversation at a time per box.** `--parallel N` slots cover voice
  pipeline concurrency (ASR draft, LLM, TTS) plus a few in-flight tool
  calls — not multi-tenant chat.
- **No datacenter multi-tenant.** If you need that, deploy via the cloud
  bundle, not these profiles.

For Kokoro voice integration (~300 MB CPU-side, no GPU footprint), see
[`eliza-1-kokoro-integration.md`](./eliza-1-kokoro-integration.md). Account
for the Kokoro buffer when sizing host RAM — VRAM is unaffected.

---

## Profile table

| GPU       | VRAM     | sm     | BW        | Best bundle           | Context | KV (K/V)         | Parallel | Batch / ubatch | DFlash min/max | mlock | Spill |
| --------- | -------- | ------ | --------- | --------------------- | ------- | ---------------- | -------- | -------------- | -------------- | ----- | ----- |
| RTX 3090  | 24 GiB   | sm_86  | 936 GB/s  | `eliza-1-9b`          | 64k     | q8_0 / q4_polar  | 4        | 2048 / 512     | 4 / 16         | yes   | no    |
| RTX 4090  | 24 GiB   | sm_89  | 1008 GB/s | `eliza-1-9b` (or 27B) | 128k    | qjl1_256 / q4_polar | 4     | 2048 / 512     | 4 / 24         | yes   | no    |
| RTX 5090  | 32 GiB   | sm_120 | 1.79 TB/s | `eliza-1-27b`         | 256k    | qjl1_256 / q4_polar | 8     | 4096 / 1024    | 4 / 24         | yes   | no    |
| H200      | 141 GiB  | sm_90  | 4.80 TB/s | `eliza-1-27b-1m`      | 1M      | qjl1_256 / q4_polar | 16    | 4096 / 2048    | 8 / 32         | yes   | no    |

All profiles set `--n-gpu-layers -1` (all layers on GPU) and `-fa on`
(flash attention). Source of truth:
[`packages/shared/src/local-inference/gpu-profiles.ts`](../packages/shared/src/local-inference/gpu-profiles.ts).

---

## Detection and application

The runtime picks a profile at engine boot:

1. `gpu-detect.ts` runs
   `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits`
   with a 3 s timeout.
2. The first reported card's name is matched against
   `matchGpuProfile()` patterns (`"h200"`, `"rtx 5090"`, `"rtx 4090"`,
   `"rtx 3090"`).
3. If matched, the `GpuProfile` flows into `applyGpuProfile(args, profile)`
   inside the llama-server spawn path. The helper is additive — it only
   injects flags the catalog / env vars haven't already set.

When detection returns `null` (non-NVIDIA host, unknown card, or no
`nvidia-smi` on PATH) the dispatcher falls back to the catalog defaults
from `runtimeFor()` in
[`packages/shared/src/local-inference/catalog.ts`](../packages/shared/src/local-inference/catalog.ts).

Env overrides (`ELIZA_LOCAL_*`) always win over the profile — operators
keep the escape hatch.

---

## Memory budgets

Single-card targets. All figures GiB. Headroom = card VRAM minus model
weights minus KV at max context.

### RTX 3090 (24 GiB)

- 9B Q4_K_M weights: ~5.4 GiB
- KV @ 64k, Q8 K + Q4 V: ~3 GiB
- Activations + drafter + 4 slots: ~3 GiB
- **Resident:** ~11.4 GiB. **Headroom:** ~12.6 GiB (driver/OS reserve ~3
  GiB on Linux, more on Windows — Windows users have ~9 GiB free).
- The 0_6b drafter (~0.3 GiB) is offloaded with `--n-gpu-layers-draft auto`.

### RTX 4090 (24 GiB)

- 9B @ 128k: weights 5.4 + KV 5–6 (QJL/Polar) = ~11 GiB. Comfortable.
- 27B @ 32k: weights 16.8 + KV ~2 + activations ~2 = ~21 GiB.
  **Tight** — Windows hosts will need to disable display compositor
  acceleration.

### RTX 5090 (32 GiB)

- 27B @ 64k: weights 16.8 + KV ~4 + activations ~3 = ~24 GiB. Plenty.
- 9B @ 256k: weights 5.4 + KV ~10 (QJL/Polar) = ~15 GiB. Plenty.
- **Caveat:** sm_120 is new. The buun-llama-cpp fork's `qjl1_256` and
  `q4_polar` kernels were originally built for sm_80/sm_89/sm_90. Verify
  they appear in the runtime's `CAPABILITIES.json` before claiming the
  profile works — `dflash-doctor` will surface the gap.

### H200 (141 GiB)

The marquee config. Eliza-1 27B at 1M context.

- Weights: 16.8 GiB
- KV @ 1M tokens, QJL K + Polar V: **~80 GiB** (~80 KiB/token quantized;
  cf. fp16 KV which would be ~280 GiB and would not fit).
- Drafter (4B Q4): 2.4 GiB
- Activations + 16 parallel slots: ~10 GiB
- **Resident:** ~110 GiB. **Headroom:** ~30 GiB.

`kvSpillToCpu` is explicitly `false` — the H200's HBM3e bandwidth (4.8
TB/s) is the whole point; PCIe Gen5 host RAM spill is two orders of
magnitude slower and would destroy TTFA.

**1M context only on H200 (or any 80 GiB+ HBM card).** On consumer cards
the KV alone exceeds VRAM at 1M; the profile system refuses the
combination by gating on `gpuProfile: "h200"` in the bundle.

---

## Expected perf

These are *targets*, not measurements. Benchmark configs are in
[`packages/inference/voice-bench/configs/gpu-benchmarks.json`](../packages/inference/voice-bench/configs/gpu-benchmarks.json);
the harness in `packages/inference/voice-bench/src/runner.ts` produces
the actual numbers.

| GPU      | Bundle           | Tokens/sec (decode) | TTFA target |
| -------- | ---------------- | ------------------- | ----------- |
| RTX 3090 | 9B @ 64k         | 35–45               | 550 ms      |
| RTX 4090 | 9B @ 128k        | 55–70               | 450 ms      |
| RTX 4090 | 27B @ 32k        | 18–25               | 700 ms      |
| RTX 5090 | 27B @ 64k        | 30–45               | 450 ms      |
| RTX 5090 | 9B @ 256k        | 60–80               | 350 ms      |
| H200     | 27B @ 1M         | 25–35               | 400 ms      |

Decode throughput estimates are derived from llama.cpp 2026-Q1 community
benchmarks for the buun-llama-cpp fork (`qjl1_256` + DFlash). The H200
1M-context number is bandwidth-bound: at 17 GiB weights + 80 GiB KV the
working set per decode step is ~3 GiB (model is read once per token, KV
is read by attention); 4.8 TB/s / 3 GiB ≈ 1600 tokens/sec theoretical,
but DFlash + KV-quant kernels run at ~25–35 t/s with one batched slot in
practice.

DFlash speculative decoding raises effective decode by 2.0–2.5× on these
profiles when the drafter accepts ≥4 tokens per step (typical on
non-thinking text). The numbers above are *with* DFlash.

---

## What the profiles don't do

- **No multi-GPU.** If you have 2× 4090, run one model per card — don't
  try to tensor-parallel split. The profile system has no concept of
  cross-card layout.
- **No CPU spill on H200.** Don't pass `--no-kv-offload` on an H200 host;
  it kills bandwidth.
- **No automatic Q3 fallback for older cards.** RTX 3090 ships Q4 weights
  + Q8 K-cache; if VRAM is tight, drop the bundle tier rather than
  silently quantizing further.

---

## Cross-references

- Profile source: [`packages/shared/src/local-inference/gpu-profiles.ts`](../packages/shared/src/local-inference/gpu-profiles.ts)
- Detection: [`packages/app-core/src/services/local-inference/gpu-detect.ts`](../packages/app-core/src/services/local-inference/gpu-detect.ts)
- Spawn integration: [`packages/app-core/src/services/local-inference/dflash-server.ts`](../packages/app-core/src/services/local-inference/dflash-server.ts) (`applyGpuProfile`)
- Manifest kernel set: [`packages/app-core/src/services/local-inference/manifest/schema.ts`](../packages/app-core/src/services/local-inference/manifest/schema.ts) (`REQUIRED_KERNELS_BY_TIER`)
- Kokoro CPU voice budget: [`docs/eliza-1-kokoro-integration.md`](./eliza-1-kokoro-integration.md)
- Optimization coverage: [`docs/ELIZA_1_OPTIMIZATION_COVERAGE_ROUND2.md`](./ELIZA_1_OPTIMIZATION_COVERAGE_ROUND2.md)
