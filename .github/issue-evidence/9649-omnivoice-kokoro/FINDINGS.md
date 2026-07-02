# Kokoro TTS — real on-device verification (Mac / Android / iOS)

Evidence captured on an M4 Max with the real fused `libelizainference.dylib`
(Jun 25 build, links libllama/libggml 0.12.0), the real `eliza-1-2b` bundle,
and a booted iPhone 16 sim + running Android arm64 emulator.

## Mac (macOS desktop) — Kokoro code path FUNCTIONAL; staged model DEGRADED

- **Synthesis runs end-to-end.** The fused lib loads `kokoro-82m-v1_0-Q4_K_M.gguf`
  through the exact `eliza_inference_kokoro_*` FFI the Android repoint uses,
  runs the phonemizer, and streams real 24 kHz PCM. Recorded
  `mac/kokoro-mac-desktop.wav` — 275040 samples @ 24 kHz (11.46 s), TTFA 313 ms,
  voice af_bella, ABI v12.
- **The eliza-1 ASR works** — a controlled known-good macOS `say` clip
  (`mac/say-reference-known-good.wav`) transcribes **perfectly**:
  `"The quick brown fox jumps over the lazy dog."`
- **But the Kokoro audio is not intelligible.** The same ASR extracts only
  `"The."` from 11.5 s of Kokoro output; voiced-frame ZCR ≈ 0.53 (real voiced
  speech is ~0.05–0.25 — noise-like), peak ≈ 0.09.
- **Root cause = lib↔model version skew, not a code regression.** The
  non-quantized `kokoro-82m-v1_0.gguf` (163 MB, HF) **fails to load** on this lib:
  `kokoro_load_model failed: required tensor missing for duration projection`.
  The Q4_K_M model loads but synthesizes degraded audio. The staged Kokoro
  assets on HF are out of sync with the shipping fused lib.
- **Secondary finding:** the `kokoro-real-smoke` envelope-cv gate (threshold 0.4)
  is **too lenient** — it PASSED (cv 0.527) on audio the ASR proves is
  unintelligible. The gate should sit closer to the "working Kokoro" reference
  (cv ≈ 1.3) or use an ASR/WER gate by default.

This is a model-publishing / lifecycle issue (relates to #10727 "publish →
download → load → run" and keeping the eliza-1 HF bundles in sync), **not**
caused by the OmniVoice→Kokoro repoint in this PR — the repoint targets the same
FFI that already synthesizes here.

## Android (arm64 emulator) — native Kokoro surface CONFIRMED

- The arm64 `libelizainference.so` exports exactly the symbols the AOSP repoint
  dlopens: `eliza_inference_kokoro_{supported,load,synthesize,sample_rate}` +
  `eliza_inference_create` (all defined `T` symbols) — so no native rebuild is
  needed for Android to use Kokoro.
- `android/emulator-home.png` — the Eliza app running on the emulator (voice mic
  UI present). Note: this is the *previously-installed* build, so it does not yet
  carry this PR's TS repoint; a rebuilt APK is needed for an end-to-end on-device
  audio capture of the new path.

## iOS (iPhone 16 simulator) — app running

- `ios/sim-home.png` — the Eliza app booted on the iPhone 16 sim. iOS TTS is the
  native-Swift Kokoro path (unchanged by this PR).

## Net
The OmniVoice→Kokoro migration in this PR is correct and the Kokoro FFI path is
functional on Mac + exported on Android arm64. The **audio-quality gap is a
separate eliza-1 model/lib version-sync problem** that must be fixed for
"Kokoro works everywhere" to be truly true — surfaced on #10727.
