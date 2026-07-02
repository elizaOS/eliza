# Kokoro TTS Metal perf — profiled root cause

**Date:** 2026-07-02 · **Host:** M4 Max · **Build:** `build-desktop-metal` (Metal, `GGML_METAL_EMBED_LIBRARY=ON`).

## Baseline (real profiled numbers)
Synthesizing 4.7 s of audio (`before.wav`, 112800 samples @ 24 kHz, peak 0.42) took **301.7 s wall** (RTF ≈ 64×). Per-phase breakdown from `kokoro-profile` instrumentation (`before-profile.log`):

| Phase | Time (ms) | Share |
|---|---:|---:|
| predictor forward | 24,188 | 8% |
| decoder front | 16,288 | 5% |
| gen: source + STFT | 66 | 0.02% |
| **generator (iSTFTNet)** | **261,220** | **87%** |
| decoder forward (total) | 277,509 | — |
| **synthesize total** | **301,697** | 100% |

## Root cause
The **iSTFTNet generator forward pass is 87% of synthesis time (261 s)**. The STFT/iSTFT math itself is trivial (66 ms) — the cost is the neural vocoder's convolution stack (HiFi-GAN-style transposed convs + resblocks in the StyleTTS-2/iSTFTNet decoder). The magnitude (261 s for a few seconds of audio) is consistent with these conv ops running **on CPU** rather than being dispatched to the Metal backend, or hitting a non-accelerated op path that forces host execution.

This is NOT a shader-compile artifact (that would front-load a fixed ~60–90 s once, not scale with the generator) and NOT the STFT. It is the generator conv graph.

## Fix direction (the actual optimization work)
Ensure the iSTFTNet generator's conv/transposed-conv/resblock ops execute on the Metal backend (or provide Metal kernels / route them to accelerated GGML ops), verifying audio output is unchanged (same duration, comparable energy/peak). Target: bring the generator from 261 s toward real-time. This is native GGML-Metal kernel work in the `elizaOS/llama.cpp` fork (`tools/kokoro/`), tracked as the next step; the profiling instrumentation (`tools/kokoro/include/kokoro-profile.h` + the `kokoro-profile` marks) is in place to measure it.

## Files
- `before-profile.log` — per-phase timings.
- `before.wav` — baseline output (audio is correct; this is purely a speed problem).
