# Voice Stack on Windows — Readiness Report

## 1. ASR plugins / components

**Primary local ASR — Qwen3-ASR via fused `libelizainference`.**
The contract (`plugins/plugin-local-inference/native/AGENTS.md:113-127`) makes this the only blessed local ASR path. It is exposed through the FFI surface in `plugins/plugin-local-inference/src/services/voice/ffi-bindings.ts:1-67` (ABI v4 `eliza_inference_asr_*`) and consumed by `plugins/plugin-local-inference/src/services/voice/transcriber.ts:1-69` (`FfiStreamingTranscriber` → `FfiBatchTranscriber` → `AsrUnavailableError`, no whisper fallback). Models ship inside the `eliza-1-<tier>` bundle (`asr/eliza-1-asr.gguf` + `asr/eliza-1-asr-mmproj.gguf`), sourced from `ggml-org/Qwen3-ASR-0.6B-GGUF` (lite/mobile/desktop) or `1.7B-GGUF` (pro/server).

**Secondary local ASR — OpenVINO Whisper.**
`plugins/plugin-local-inference/src/services/voice/openvino-whisper-asr.ts:1-100` — but it shells out to a Python venv at `~/.local/voice-bench/ov_venv/bin/python` (Linux path; **no Windows path is in the candidate list**). It also defaults to `NPU,CPU` device chain (Lunar Lake NPU). Effectively unavailable on this Windows box without manual venv setup.

**Cloud ASR.**
- ElevenLabs STT (`plugins/plugin-elevenlabs/src/index.ts:170-193`, model `scribe_v1`).
- Groq Whisper (`plugins/plugin-groq/index.ts:52` `whisper-large-v3-turbo`).
- OpenAI Whisper-1 (`plugins/plugin-openai/index.ts:181`).
- Eliza Cloud proxy (`plugin-elizacloud`).
- Browser Web Speech API in renderer (`packages/native-plugins/talkmode/src/web.ts:84-129`, `packages/ui/src/hooks/useVoiceChat.ts:9`).

**Explicit non-providers:** `plugin-omnivoice` throws `OmnivoiceTranscriptionNotSupported` (`plugins/plugin-omnivoice/src/index.ts:182-187`). Whisper.cpp is removed from contract (AGENTS.md §1).

## 2. TTS plugins

| Plugin | Local? | Notes |
|---|---|---|
| `plugin-omnivoice` (`plugins/plugin-omnivoice/src/index.ts`, `src/ffi.ts:171-175`) | yes | Loads `omnivoice.dll` on Windows via `bun:ffi`. Requires `OMNIVOICE_MODEL_PATH` + `OMNIVOICE_CODEC_PATH` GGUFs. Auto-discovery at `<stateDir>/models/omnivoice/{speech,singing}/` (`src/discover.ts:115-128`). Speech-variant fetch is **not yet automated** (`scripts/inference/omnivoice-fetch.mjs:156-180`). |
| `plugin-local-inference` (fused) — Kokoro-82M ONNX + OmniVoice | yes | Kokoro is default for `0_8b`/`2b`/`4b` tiers (`plugins/plugin-local-inference/src/services/voice/kokoro/kokoro-backend.ts`). Bundled ONNX, ~80 MB int8. |
| `plugin-edge-tts` (`plugins/plugin-edge-tts/src/index.ts`) | online | Free MS Edge endpoint, no API key. Auto-enables under `ELIZA_CLOUD_PROVISIONED=1` or `features.tts`. |
| `plugin-elevenlabs` (`plugins/plugin-elevenlabs/src/index.ts:226-272`) | cloud | Streaming + STT. |
| `plugin-openai`, `plugin-groq`, `plugin-elizacloud` | cloud | Standard TTS endpoints. |
| Browser `SpeechSynthesis` | local | Renderer fallback (`packages/ui/src/hooks/useVoiceChat.ts:1-10`). |

Routing precedence is documented in `plugins/plugin-local-inference/src/services/router-handler.ts:28-58`: local-inference → elizacloud → elevenlabs → openai → groq → edge-tts.

## 3. Audio I/O on Windows

**Mic capture (CLI / Node side):** `plugins/plugin-local-inference/src/services/voice/mic-source.ts:158-188` — Windows path is **ffmpeg `-f dshow` only**, with a hardcoded default `audio=Microphone (Realtek(R) Audio)` (line 167). No WASAPI native binding, no fallback. The same hardcoded assumption appears in `plugins/plugin-vision/src/audio-capture.ts:85-89`.

**Audio playback (CLI / Node side):** `plugins/plugin-local-inference/src/services/voice/system-audio-sink.ts:149-156` — Windows path tries `ffplay` then `sox`. If neither is present, falls back to `WavFileAudioSink` (no streaming).

**Renderer (desktop app / Electrobun / browser-bridge):** Uses `getUserMedia` + `MediaRecorder` + Web Speech API + `AudioContext` (`packages/ui/src/voice/voice-chat-recording.ts`, `voice-chat-playback.ts`, `useVoiceChat.ts`). This path is independent of ffmpeg and works on Windows when the WebView grants mic permission. The `PushMicSource` class in `mic-source.ts` is the seam the renderer feeds PCM into.

**Critical finding on this machine:** `where ffmpeg`, `where ffplay`, `where sox` all return nothing. **The CLI `voice:interactive` script will fail at the mic step and fall back to WAV-file playback.** The Electrobun renderer path is the only one that will work today without installing ffmpeg.

## 4. End-to-end voice flow

Documented in `docs/voice-interactive.md:14-24` and traced through:
mic source (`mic-source.ts`) → `PcmRingBuffer` (`ring-buffer.ts`) + VAD (`vad.ts`, Silero v5 ONNX) → streaming transcriber (`transcriber.ts`) → `VoiceTurnController` (`turn-controller.ts`) → runtime message handler → `PhraseChunker` (`phrase-chunker.ts`) → TTS backend (Kokoro / OmniVoice via `kokoro-backend.ts` / fused FFI) → `SystemAudioSink` (`system-audio-sink.ts`). Renderer flow lives in `packages/ui/src/hooks/useVoiceChat.ts` and the `/api/tts/cloud` route (`packages/app/test/ui-smoke/tts-stt-e2e.spec.ts:1-44`).

## 5. Existing tests

- Unit: `plugin-local-inference/src/services/voice/*.test.ts` (mic-source, transcriber, vad, voice-state-machine, etc.) — all pure, no audio I/O.
- e2e: `plugin-local-inference/src/services/voice/interactive-session.e2e.test.ts` — stub backends, synthetic PCM. Cross-platform.
- UI smoke: `packages/app/test/ui-smoke/tts-stt-e2e.spec.ts` — Playwright, mocks `webkitSpeechRecognition` and `/api/tts/cloud`. Wiring only — does not exercise real backends.
- QA: `packages/app-core/test/app/qa-checklist.real.e2e.test.ts` — uses real ElevenLabs key if set, gated on `CHROME_PATH` (defaults to macOS path; needs `ELIZA_CHROME_PATH` env override on Windows).
- Plugin-level: `plugin-edge-tts/__tests__/`, `plugin-elevenlabs/__tests__/streaming.test.ts`, `plugin-omnivoice/__tests__/ffi-shape.test.ts` etc. — mostly mocks; omnivoice FFI tests do not load a real `.dll`.

No test on disk runs the **whole** loop on Windows with real audio I/O.

## 6. Known Windows pitfalls

- **No `ffmpeg`/`ffplay`/`sox` on PATH on this box** — must install before any CLI voice flow works.
- Hardcoded mic device name `Microphone (Realtek(R) Audio)` in `mic-source.ts:167` and `audio-capture.ts:85-88`. If the host's default mic enumerates as a different friendly name (USB headset, "Microphone Array"), dshow fails silently.
- ONNX runtime: `onnxruntime-node` is an **optional dependency** (`plugin-local-inference/package.json:56-60`). On Windows-x64 the npm package ships a prebuild; on Windows-arm64 it does not — Silero VAD then hard-errors with no fallback (`docs/voice-interactive.md:38`).
- `omnivoice.dll` is **not in-tree** — must be built via `plugins/plugin-local-inference/native/build-omnivoice.mjs` (CUDA/Vulkan/CPU; no Metal). The `voice-interactive` harness expects the **fused** `libelizainference.dll` produced by `packages/app-core/scripts/omnivoice-fuse/`, which uses CMake against the elizaOS llama.cpp fork. Per `README.md` graft strategy, Windows is supported but requires MSVC + CMake + Python (for `convert.py`).
- OpenVINO Whisper Python venv path is Linux-only (`openvino-whisper-asr.ts:46-69`).
- Sample-rate mismatch risk: CLI ASR is 16 kHz mono; OmniVoice codec is 24 kHz mono (`plugin-omnivoice/src/ffi.ts:348-351`). The pipeline resamples via `resampleLinear` (linear interp, not polyphase) — fine for ASR, marginal for music/singing TTS.
- The standalone `plugin-omnivoice` is **legacy** per AGENTS.md §1 (lines 99-104); new work should target the fused `libelizainference`.

## 7. Verification checklist (prioritized for this Windows box)

**P0 — environment prereqs (do these first, nothing else works without them):**
1. Install ffmpeg + ffplay onto PATH (winget `ffmpeg`); re-run `where ffmpeg ffplay`.
2. Confirm default microphone friendly name (`ffmpeg -list_devices true -f dshow -i dummy`). If not `Microphone (Realtek(R) Audio)`, set explicit device in the mic source or expect dshow to fail.
3. Confirm WebView mic permission works in Electrobun shell (open dev build, hit chat composer mic button).
4. `bun run voice:interactive -- --platform-report` → captures host-aware capabilities.
5. `bun run voice:interactive -- --list-active` → reports missing models.

**P1 — TTS-only paths (faster to verify, fewer moving parts):**
6. `plugin-edge-tts` via CLI: feed any text → mp3 buffer. No API key.
7. `plugin-elevenlabs` TTS via API key (if `ELEVENLABS_API_KEY` available).
8. `plugin-openai` TTS via API key.
9. `plugin-groq` TTS via API key.
10. `plugin-omnivoice` TTS: build `omnivoice.dll`; stage speech GGUFs manually (see `omnivoice-fetch.mjs:156-180` — speech variant is not automated); call `useModel(ModelType.TEXT_TO_SPEECH, "hello")`.
11. Kokoro-82M ONNX TTS: requires fused `libelizainference.dll` build + `eliza-1-2b` bundle staged.
12. Renderer-side `SpeechSynthesis` fallback in Electrobun.
13. Renderer-side ElevenLabs streaming via `/api/tts/cloud` (covered by `tts-stt-e2e.spec.ts`).

**P2 — ASR paths:**
14. ElevenLabs STT: POST a WAV → expect transcript.
15. Groq Whisper STT: same.
16. OpenAI Whisper STT: same.
17. Web Speech API STT in renderer (`webkitSpeechRecognition`) — Edge WebView2 supports it.
18. Fused Qwen3-ASR via `libelizainference.dll` — requires bundle.
19. OpenVINO Whisper — Windows venv setup is unsupported in tree; skip or write a Windows venv resolver.

**P3 — full loops:**
20. `bun run voice:interactive -- --say "hello"` (skip ASR; exercises LLM→TTS→speaker).
21. `bun run voice:interactive -- --wav fixture.wav` (skip mic; full mic→VAD→ASR→LLM→TTS→speaker on a file).
22. `bun run voice:interactive` (real mic, full loop, Electrobun and CLI).
23. Mobile-bridge entry — N/A on this machine.

Files to consult while building those:
- `packages/app-core/scripts/voice-interactive.mjs:1295-1351` (preflight + auto-download flow)
- `plugins/plugin-local-inference/src/services/voice/mic-source.ts:158-188` (Windows dshow path; the `device` override is the seam to fix the hardcoded Realtek name)
- `plugins/plugin-local-inference/src/services/voice/system-audio-sink.ts:149-156` (Windows player resolution)
- `packages/app-core/scripts/omnivoice-fuse/README.md` (how to build the fused DLL)
- `plugins/plugin-omnivoice/RESEARCH.md` and `docs/inference/omnivoice-readiness.md` (model staging)
