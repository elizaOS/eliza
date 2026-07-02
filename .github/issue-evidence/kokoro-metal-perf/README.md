# Kokoro TTS perf — profiled root cause + fix (417× total speedup, now faster than real-time)

**Date:** 2026-07-02 · **Host:** M4 Max · **Build:** `build-desktop-metal` (Metal, `GGML_METAL_EMBED_LIBRARY=ON`, Release `-O3`).
**Phrase (both runs):** `"The quick brown fox jumps over the lazy dog near the riverbank."` · model `kokoro-82m-v1_0-Q4_K_M.gguf` (eliza-1-0_8b bundle) · voice `af_bella`.

## Before → after (real measured numbers, same phrase/model/voice/harness)

| Phase | Before (ms) | After (ms) | Speedup |
|---|---:|---:|---:|
| predictor forward | 24,188 | 113 | 214× |
| decoder front | 16,288 | 15 | 1,092× |
| gen: source + STFT | 66 | 27 | 2.4× |
| **generator (iSTFTNet)** | **261,220** | **595** | **439×** |
| decoder forward (total) | 277,509 | 610 | 455× |
| **synthesize total** | **301,697** | **723** | **417×** |

**RTF:** 4.7 s of audio (112,800 samples @ 24 kHz) took 301.7 s (RTF ≈ 64× *slower* than real-time) → **0.72 s (RTF ≈ 0.15, i.e. ~6.5× faster than real-time)**.

## Audio correctness (after == before)

- `after.wav`: **samples=112800 (identical)**, rate=24000, peak **0.4195** (before 0.4212 — fp32 summation-order delta through the conv stacks + `exp()` spec head).
- Pearson correlation before↔after: **0.99959**; RMS 0.03924 vs 0.03924; max abs sample delta 0.0167 (±1 scale).
- faster-whisper (base) transcription of both WAVs: `"The quick brown fox jumps over the lazy dog near the riverbank."` — word-for-word identical.

## Root cause (corrected from the baseline hypothesis)

The baseline README hypothesized "conv ops falling back from Metal to CPU". Reality: **the iSTFTNet generator never enters ggml at all** — there is no ggml graph and therefore no Metal dispatch to fall back *from*. The whole StyleTTS-2 decoder (predictor, decoder front, iSTFTNet generator) is a hand-written, header-only, **single-threaded scalar** port (`tools/kokoro/include/kokoro-layers.h`, "CPU scalar" by design), with a branchy per-element bounds check in the innermost Conv1d loop. At the generator's ~85 GMACs per 4.7 s utterance, `-O3` scalar ≈ 261 s. `user≈real` in the baseline (`234 s user / 302 s real`, 1 thread) confirms pure CPU-bound scalar execution — not a shader/backend issue.

## Fix (this change)

`kokoro-layers.h` now routes the four hot primitives through **Apple Accelerate BLAS** (AMX-backed) on `__APPLE__`, keeping the portable scalar loops as the non-Apple fallback and readable reference:

- `conv1d_forward` → im2col + one `cblas_sgemm` (PyTorch `[Cout, Cin, K]` weight is already a row-major `[Cout, Cin*K]` GEMM operand; stride/dilation/zero-pad baked into the column matrix).
- `convtranspose1d_forward` → one `cblas_sgemm` (`tmp[Cout*K, T] = Wᵀ·x`) + cheap col2im scatter-add.
- `linear_forward` → `cblas_sgemv`.
- `lstm_cell_step` gate pre-activations → two `cblas_sgemv` (this is what took the predictor 24.2 s → 0.11 s).

`tools/kokoro/CMakeLists.txt` links `Accelerate.framework` into `kokoro_lib` (PUBLIC) on Apple; verified propagated into both `kokoro-tts` and the fused `libelizainference.dylib` (`otool -L`). Same math, same fp32 accumulation — only the summation order differs.

## Non-Apple fallback (Android/Windows/Linux) — threaded + NEON portable path

Follow-up (submodule commit `2bdcef890`, branch `kokoro-portable-fast`): the Accelerate speedup above is `#if __APPLE__` only — Android/Windows still ran the single-threaded scalar generator (261 s). `kokoro-layers.h` now has a third compile-time path, `KOKORO_USE_PORTABLE_FAST`, selected automatically on every non-Apple platform:

- **Threading:** a small internal `std::thread` pool (no new deps; `min(hardware_concurrency, 16)`, override with `KOKORO_NUM_THREADS`) parallelizes `conv1d_forward` / `convtranspose1d_forward` over output channels and `linear_forward` / `lstm_cell_step` over gate/output rows. Each worker owns disjoint output rows — no atomics in the MAC loops. A 256k-MAC threshold keeps small per-step calls (sequential LSTM) off the pool.
- **NEON (`__aarch64__` / `_M_ARM64`):** the innermost MACs are branch-free AXPY/dot kernels using `vfmaq_f32` (2×128-bit accumulators). Valid-tap ranges are hoisted out of the inner loops, killing the per-element bounds check of the reference loop. Non-NEON targets (x86) get the same branch-free loops, auto-vectorizable at `-O3`.
- **Reference retained:** the pure scalar loops are unchanged as the ultimate fallback + numerical reference (`-DKOKORO_FORCE_SCALAR`); `-DKOKORO_NO_ACCELERATE` forces the portable path on Apple hosts for testing.

**Correctness (executed natively on this M4 Max — arm64, so the NEON kernels are the exact code aarch64 Android runs):** `tools/kokoro/tests/test_kokoro_layers_portable` runs 23 parity checks fast-vs-scalar-reference on random input across all four primitives, including stride-6/10, dilation-3/5, K=1, T=1, out-of-bounds-tap and no-bias edges — **max |Δ| = 1.9e-5, all < 1e-4 (PASS)**. Cross-compile verified with NDK r29 clang for `aarch64-linux-android26` and `x86_64-linux-android26` (`-Wall -Wextra` clean; `llvm-objdump` shows 18 `fmla.4s` vector FMAs in the aarch64 object).

**Microbench (same binary, M4 Max, 16 threads, NEON, real generator shapes):**

| Primitive (real iSTFTNet shape) | scalar (ms) | portable-fast (ms) | speedup |
|---|---:|---:|---:|
| conv1d 256→256 T=2640 K=7 d=3 (stage-0 resblock) | 3,843.7 | 35.82 | 107.3× |
| conv1d 128→128 T=15841 K=11 d=5 (stage-1 resblock) | 8,124.5 | 89.09 | 91.2× |
| convtranspose 512→256 T=264 K=20 s=10 (ups[0]) | 1,212.6 | 65.27 | 18.6× |
| convtranspose 256→128 T=2640 K=12 s=6 (ups[1]) | 1,579.7 | 169.21 | 9.3× |
| LSTM I=512 H=512 × 264 steps (predictor-sized) | 998.6 | 217.66 | 4.6× |

(Numbers are from the checked-in `portable-fast-parity-microbench.log` run; this host was carrying a concurrent agent-swarm load — an earlier idle-host run of the same binary measured 172.7× / 164.6× / 25.4× / 15.1× / 4.1× on the same rows. Ratios are the durable signal.) The generator's runtime is dominated by the resblock convs (~85 GMACs), so a ~100×-class conv speedup takes the 261 s non-Apple generator into the low single-digit seconds on comparable cores (phone cores are slower and fewer — expect tens of × end-to-end, to be measured on-device). `tools/kokoro/CMakeLists.txt` links `Threads::Threads` on non-Apple. Apple path untouched; `cmake --build build-desktop-metal --target kokoro-tts` rebuilt green after the change.

## Remaining work (true GPU port — optional now)

The fork's Metal backend already supports every op an iSTFTNet ggml graph would need (`GGML_OP_IM2COL`, `GGML_OP_CONV_TRANSPOSE_1D`, `GGML_OP_PAD_REFLECT_1D`, `GGML_OP_SIN`/`COS`/`EXP` for the Snake activation and spec/phase heads, `GGML_OP_NORM`, and the custom `GGML_OP_ISTFT` / ELIZA-ISTFT-DISPATCH-V1 — see `ggml/src/ggml-metal/ggml-metal-device.m`). Building the generator as a ggml graph on Metal/Vulkan is now a latency/energy optimization on every platform: Apple runs Accelerate (RTF 0.15) and non-Apple runs the threaded+NEON portable path above.

## Files
- `before-profile.log` / `before.wav` — baseline (scalar), RTF 64×.
- `after-profile.log` / `after.wav` — Accelerate BLAS path, RTF 0.15, audio equivalent (corr 0.99959, identical transcript).
- `portable-fast-parity-microbench.log` — non-Apple path: 23/23 parity PASS + the microbench table above.
