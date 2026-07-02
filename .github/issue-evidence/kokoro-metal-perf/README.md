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

## Remaining work (true GPU port — optional now)

The fork's Metal backend already supports every op an iSTFTNet ggml graph would need (`GGML_OP_IM2COL`, `GGML_OP_CONV_TRANSPOSE_1D`, `GGML_OP_PAD_REFLECT_1D`, `GGML_OP_SIN`/`COS`/`EXP` for the Snake activation and spec/phase heads, `GGML_OP_NORM`, and the custom `GGML_OP_ISTFT` / ELIZA-ISTFT-DISPATCH-V1 — see `ggml/src/ggml-metal/ggml-metal-device.m`). Building the generator as a ggml graph on Metal is now a latency/energy optimization, not a correctness/usability blocker: at RTF 0.15 on CPU/AMX the vocoder is comfortably real-time. Non-Apple hosts (Android/Windows) still take the scalar path and would benefit first from a ggml-graph port or a NEON/threaded fallback.

## Files
- `before-profile.log` / `before.wav` — baseline (scalar), RTF 64×.
- `after-profile.log` / `after.wav` — Accelerate BLAS path, RTF 0.15, audio equivalent (corr 0.99959, identical transcript).
