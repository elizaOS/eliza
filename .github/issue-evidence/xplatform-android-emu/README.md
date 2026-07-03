# xplatform-android-emu — local-inference on Android emulator (LIVE, emulator-5554)

Captured 2026-07-02/03 on sdk_gphone64_arm64 (arm64 AVD on M4 Max), `ai.elizaos.app`
debug build from this branch (fused-lib + renderer + plugin-manifest fixes below).
All clips ≤25s, ffprobe-verified, committed incrementally.

## Artifacts

| File | What it shows |
|---|---|
| `00a-BEFORE-renderer-crash-error-card.png` | Shipped build hard-crashed at boot: "Failed to construct 'URL': Invalid URL" error card (ComputerUseApprovalOverlay vs `eliza-local-agent://ipc` base on Android WebView). |
| `00b-AFTER-home-screen-healthy.png` | Same device after the fix — real home surface. |
| `01-chat-send.mp4` / `01b-chat-sent-typing-indicator.png` | Typing + sending a chat message to the ON-DEVICE agent through the real UI. |
| `02-chat-reply.mp4` | Chat surface during local generation (server log: `Android local direct chat fast path done latencyMs=27502`). |
| `03-tts-kokoro-ondevice.wav` | 4.81s 24kHz WAV synthesized ON-DEVICE by fused kokoro (`synthMs=82`, `wavBytes=230924`). NOTE: on-device ASR round-trip of this WAV returns an EMPTY transcript — kokoro vocoder output is not intelligible speech (known defect, #10727 thread). Path fires; audio quality broken. |
| `04-stt-input.wav` | 3.9s input for the STT leg. On-device eliza-1 ASR transcribed it EXACTLY: "Hello, Eliza. This is a local speech recognition test on Android." (~25s). |
| `05-agent-log-tts-asr.txt` | `[aosp-local-inference]` log lines proving fused kokoro TTS + eliza-1 ASR fired natively. |
| `06-ocr-test-image.png` | OCR input image ("HELLO ELIZA 42" / "OCR BRIDGE ANDROID"). |
| `07-mlkit-ocr-result.json` | Real ML Kit Text Recognition v2 output on-device via the registered `@elizaos/capacitor-mlkit-text` plugin (pluginId `Tesseract`, #11111): every word conf 1.0, correct block/line grouping + boxes. |
| `08-logcat-mlkit-ocr.txt` | logcat: `libmlkit_google_ocr_pipeline.so` + gocr tflite models loading, plugin call, and the renderer OCR-bridge poller hitting `/api/vision/ocr-requests` (200 after the plugin-vision registration fix; previously an endless 404 loop). |
| `09-mlkit-ocr-during-call.mp4` | 20s screenrecord during the OCR call. |
| `10-agent-log-key-lines.txt` | Fused text-gen registration, kokoro TTS completion, vision plugin registration. |

## Per-feature verdicts

- **Text generation (eliza-1-2b-32k, fused libelizainference, CPU):** WORKS.
  Cold 128.6s (model load + q4_K repack on emulated CPU), warm 27.5s for a short
  reply. KV-quant (qjl1_256/q4_polar) is REJECTED by this fused build
  ("V cache quantization requires flash_attn") — survives via the new loud f16
  retry; memory optimization disabled until the native side wires flash_attn.
- **TTS (kokoro):** path WORKS end-to-end (route → fused kokoro → 24kHz WAV in
  2.2s), audio NOT intelligible (ASR round-trip empty) — known vocoder defect.
- **STT (eliza-1 ASR + audio mmproj):** WORKS, exact transcript.
- **Vision / OCR (#11111):** ML Kit OCR WORKS on-device with perfect output;
  OCR-bridge routes + renderer poller live. Driven via the registered Capacitor
  plugin (CDP) — NOT via the agent planner: the 2b planner answered REPLY
  instead of VISION/get_screen in the one live full-pipeline attempt.
  IMAGE_DESCRIPTION: N/A on Android — the AOSP path registers
  TEXT_SMALL/LARGE/EMBEDDING/TTS/TRANSCRIPTION only and no vision mmproj is
  staged on-device.

## Fixes shipped while capturing (this branch)

1. `bd5999b8804` fix(ui): ComputerUseApprovalOverlay hard-crashed the whole
   shell on native IPC bases (Android WebView URL parser) + regression test.
2. `590c24762ab` fix(aosp-local-inference): readFfiPointer masked every native
   error as "Expected a pointer" (bun `read.ptr` needs a raw pointer, not a
   Buffer); flat `models/*.gguf` layout shim (fused lib requires
   `<root>/text/*.gguf`); ELIZA_LLAMA_KV_TYPE_K/V + loud f16 retry on KV-quant
   rejection. 75 bun tests pass.
3. `d3c64ebd12e` fix(agent): plugin-vision missing from
   CORE_STATIC_PLUGIN_REGISTRATIONS — mobile bundle could never load it
   (renderer OCR poller 404-looped forever).
4. `1e4c511751c` fix(mobile-build): stale legacy `packages/app/android` tree
   stomped the freshly synced `capacitor.plugins.json` (33 plugins found,
   15 shipped) — silently unregistering ML Kit OCR, ScreenCapture, and every
   newer native plugin.

## Residuals (not code in this branch)

- The tree-staged `libelizainference.so` (4.7 MB, Jul 2 20:15) is a BROKEN
  artifact: 512 undefined ggml symbols with `DT_NEEDED` only `libc.so`,
  violating the "statically fused" contract in `ElizaVoiceNative.java`. The
  working 72 MB fused lib from
  `~/.cache/eliza-android-agent/llama-cpp-v1.2.0-eliza/build-arm64-v8a/bin/`
  (built Jul 2 20:21) was re-staged into
  `packages/app-core/platforms/android/app/src/main/{jniLibs,assets/agent}/arm64-v8a/`
  for these captures. The `compile-libllama.mjs` staging lane (in-flight
  gemma-4/MTP work) needs to stop producing/staging the dynamic variant.
- Kokoro audio intelligibility (native vocoder) — tracked in the #10727 thread.
- Chat reply bubble rendered late in the UI relative to server-side completion
  on one turn (typing indicator persisted after `fast path done`); not
  root-caused.
- The one live full-pipeline attempt to make the 2b planner call
  VISION/get_screen chose REPLY instead (response also leaked `<end_of_turn>`
  scaffolding) — planner-quality issue on the 2b at CPU speeds.
