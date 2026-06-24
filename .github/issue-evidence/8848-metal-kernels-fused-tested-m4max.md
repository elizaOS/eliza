# #8848 — QJL / TurboQuant / PolarQuant Metal kernels: fused, tested, + a real regression fixed (Apple M4 Max)

**Date:** 2026-06-23 · **Device:** Apple M4 Max (Metal 4, macOS 26) · fork `elizaOS/llama.cpp` `main-b10024-…-g678473455`

## TL;DR

The QJL / TurboQuant / PolarQuant kernels are **already Metal and already fused** in the
llama.cpp fork (`ggml/src/ggml-metal/eliza-shipped/*.metal`), embedded into `default.metallib`
and runtime-gated in `supports_op`. I ran the **full correctness + dispatch + perf suite on the
M4 Max**, and in the process **found and fixed a shipped-kernel regression** that the existing
gate could not see.

## 1. Kernel parity vs the C reference — `metal_verify` (tol 1e-3)

All run on the M4 Max GPU, bit-compared to `reference/turbo_kernels.c` + `verify/qjl_polar_ref.c`:

| Suite | Result |
|---|---|
| `metal-verify` (turbo3/turbo4/turbo3_tcq/qjl/polar ±QJL/polar-preht) | **8/8 each** |
| `metal-verify-multiblock` (n=2,3,4,8) | **PASS** |
| `metal-verify-fused` — `kernel_fused_attn_qjl_tbq3_f32` | **1920/1920 + 1536/1536 causal**, max_diff 5.5e-7 |
| `metal-verify-fused` — `kernel_fused_attn_qjl_polar_f32` | **1920/1920 + 1536/1536 causal**, max_diff 9.5e-7 |
| `metal-verify-fused` — `kernel_attn_score_q4_polar_preht_f32` (multi 2/3/4/8) | **8/8 each** |

The **fused attention** kernels (QJL-K + TBQ-V and QJL-K + Polar-V) are one-pass online-softmax
kernels (per-token QJL score via `simd_sum`, threadgroup-scratch Hadamard, score vector never
materialized) — verified byte-faithful to the C reference.

## 2. Built-fork Metal graph-dispatch smoke (`dispatch_smoke.mm`)

Proves a real ggml Metal graph route selects each kernel on the M4 Max:

```
PASS GGML_OP_ATTN_SCORE_QJL            max diff 2.4e-7
PASS GGML_OP_ATTN_SCORE_TBQ/turbo3     max diff 4.8e-7   <- was FAIL before the fix
PASS GGML_OP_ATTN_SCORE_TBQ/turbo4     max diff 4.8e-7   <- was FAIL before the fix
PASS GGML_OP_ATTN_SCORE_TBQ/turbo3_tcq max diff 4.8e-7
PASS GGML_OP_ATTN_SCORE_POLAR (use_qjl 0/1)
PASS GGML_OP_ATTN_SCORE_POLAR_PREHT (use_qjl 0/1)
PASS GGML_OP_FUSED_ATTN_QJL_TBQ        max diff 5.96e-8
PASS Metal dispatch suite: 9 graph routes
```

## 3. The regression (found + fixed)

Fork commit **`412b8487b "fix(metal): correct TBQ3_0/TBQ4_0 attention score kernels"`** actually
**regressed** `kernel_turbo3_dot` / `kernel_turbo4_dot` in `eliza-shipped/`:

- `eliza-shipped/turbo3.metal` (what the runtime embeds): **metal_verify 0/8** (outputs 20–170× off).
- `native/metal/turbo3.metal` (what the gate tests): **metal_verify 8/8**.

**Why it shipped unguarded:** `metal-verify` points at `../metal/*.metal` (the verify-harness copy),
not the `eliza-shipped/*.metal` copies the fork embeds into `default.metallib`. The two drifted; the
gate stayed green while the runtime shipped broken TBQ3_0/TBQ4_0 attention scores. (Production impact
is bounded: per `native/AGENTS.md §3` the head_dim=128 TBQ/QJL/Polar KV kernels are **optional for the
shipped Gemma-4 tiers**, and the production-optimized **fused** TBQ path was unaffected — but tbq3_0/tbq4_0
is the ≤8k V-cache option for the legacy Qwen-shaped tiers.)

**Fix:** restored `eliza-shipped/turbo3.metal` + `turbo4.metal` from the verified `native/metal/`
copies (submodule commit `05baa0f69`; patch at `native/patches/fix-metal-tbq3-tbq4-attn-score-regression.patch`).
After the fix: `dispatch_smoke` **9/9 PASS**, all shipped kernels parity-PASS.

**Guard (prevents recurrence):** new `make metal-verify-shipped` target runs the parity harness
against the `eliza-shipped/` kernels the runtime actually embeds (turbo3/4/3_tcq, qjl, polar±qjl,
both fused) — closes the test-coverage gap that hid this.

## 4. Metal performance (M4 Max, `metal_bench`)

Single-block (latency-bound): turbo3/4 ~214 µs (156 GF/s), qjl 227 µs, polar 344 µs (heavier:
Hadamard-128 + Lloyd-Max LUT), polar_preht 215 µs. Batched (b=256): ~210 µs/block turbo, 213 µs qjl,
351 µs polar. Fused-attn pass: qjl_tbq3 ~7.2 ms, qjl_polar ~9.2 ms (compute-bound online softmax).

## 5. CoreML / ANE assessment

- **Custom quant KV kernels (QJL/Polar/TBQ):** CoreML/ANE runs fixed Core-ML graph ops; it **cannot
  execute custom compute kernels** like 1-bit JL-sketch K-cache scoring or Hadamard-rotated Lloyd-Max
  V-cache fused attention. **Metal compute is the correct and only viable backend** — and it's verified
  correct + benchmarked here.
- **LLM / ASR / voice:** run through the llama.cpp **Metal** backend today (LLM 250 tok/s decode;
  whisper + Qwen3-ASR transcribe correctly on Metal — see `9147-voice-asr-m4max.md`). Per
  `native/AGENTS.md §11`, a CoreML/MLX backend **compiled into `libelizainference`** is architecturally
  permitted as the owned Apple backend, but it is a *future alternative*, not a correctness gap — the
  Metal path is the verified, optimized current backend.
- **whisper.cpp `WHISPER_COREML=OFF`:** whisper is a **dev/legacy** tool, not the production ASR path
  (production ASR is Qwen3-ASR via `eliza_pick_asr_files()`, per §1). Enabling its CoreML encoder would
  optimize a non-shipping path — not recommended.

**Net:** all five kernels are Metal + fused + now parity-clean on real Apple-Silicon GPU, the runtime
graph dispatches all 9 routes correctly, a real shipped regression is fixed, and the gate gap that hid
it is closed. Metal is the right backend; CoreML is N/A for the custom kernels and a deferred alt for
the model path.
