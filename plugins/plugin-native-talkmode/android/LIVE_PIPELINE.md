# Android live voice pipeline: `audioFrame` → speaker-attributed turns

This document maps the **end-to-end on-device** path that turns the Android
`audioFrame` PCM stream (see [`AUDIO_FRAMES.md`](./AUDIO_FRAMES.md)) into live,
VAD-segmented, speaker-attributed voice turns.

There are two transports, and they target different builds. For the **normal
Android APK** (`ai.elizaos.app`) the canonical path is the **in-process
JNI/bionic host** — the four fused voice classifiers run inside the Capacitor
app process via `libelizainference.so`, with no separate agent process and no
HTTP hop. The legacy **musl bun-agent transport** remains only for the
privileged AOSP build (where the embedded bun agent runs platform-signed); it is
not the path the normal APK uses.

## The canonical pipeline (normal APK: in-process JNI/bionic host)

```
 Android native AudioRecord (plugin-native-talkmode, Kotlin)
   │  emits `audioFrame` Capacitor event: base64 LE-s16 16 kHz mono PCM,
   │  20 ms/frame, { sampleRate, channels, samples, rms, timestamp, frameIndex }
   ▼
 Capacitor WebView (JS renderer)
   │  TalkMode.addListener("audioFrame", …)  →  JniVoicePipeline
   │    (packages/ui/src/voice/jni-voice-pipeline.ts)
   │  batches ~1 s of frames → ElizaVoice.pipelineProcess({ handle, pcm16 })
   ▼
 ElizaVoice JNI host  (ai.elizaos.app process, BIONIC — same process, NO agent)
   │  packages/app-core/platforms/android/app/src/main/elizavoice-jni/
   │  libelizavoicejni.so → libelizainference.so (fused, ABI v7, all four runtimes)
   │  1. native VAD hot-loop + turn segmentation (ported VadDetector state machine):
   │       streams the PCM through eliza_inference_vad_process, applies the
   │       onset/offset/pause/end-hangover thresholds, buffers the turn PCM
   │       (+ pre-roll) between speech-start and speech-end — ZERO per-512-window
   │       JS↔native bridge calls.
   │  2. on speech-end: eliza_inference_speaker_embed (256-d WeSpeaker embedding)
   │       + eliza_inference_diariz_segment (293 pyannote frame labels), natively.
   │  3. returns a turn-level result (base64 embedding + int8 labels) to JS.
   ▼
 JS (JniVoicePipeline)
   │  decodes the embedding + labels, runs the injected speaker resolver
   │  (embedding → enrolled entity) and buildVoiceTurnSignal (the ambient gate),
   │  and surfaces a JniAttributedTurn.
   ▼
 voiceTurnSignal  → the `core.voice_turn_signal` server gate decides
                     whether the agent speaks (owner / bystander / wake word).
```

The native ops the JNI host wraps (all `eliza_inference_*`, fused into the one
`libelizainference.so`):

| Stage | JNI surface | native runtime |
|---|---|---|
| Silero VAD (turn segmentation) | `vad open/processBatch/reset/close` + the streaming `pipeline*` | `eliza_inference_vad_*` |
| openWakeWord ("hey eliza") | `wakeword open/scoreBatch/reset/close` | `eliza_inference_wakeword_*` |
| WeSpeaker encoder (speaker embedding) | `speaker open/embed/close` | `eliza_inference_speaker_*` |
| pyannote diarizer (segment by speaker) | `diariz open/segment/close` | `eliza_inference_diariz_*` |

Each resolves its GGUF from the on-device bundle
(`<files>/eliza-1/bundle/{vad,wake,speaker,diariz}/…`). The split is: the VAD
hot-loop + turn segmentation + speaker/diariz forward passes run natively; the
speaker-match-against-enrolled-profiles + the ambient gate stay in JS (per-turn,
infrequent).

## What is verified on-device (Pixel 9a, `ai.elizaos.app`)

The whole pipeline runs in the bionic app process — proven via CDP + logcat
(the in-process verification channel; every line is emitted by the
`ai.elizaos.app` pid, never the agent):

- **ABI + capability**: `eliza_inference_abi_version() = 7`, and all four
  classifiers report supported in-process: `vad=1 wakeword=1 speaker=1 diariz=1`.
- **Full pipeline on real speech** (`freeman.wav` + 2 s trailing silence, fed in
  1 s batches via `pipelineSelfTest`):
  ```
  pipelineSelfTest: feeding 308224 samples (19.26s), chunk=16000
  TURN jni_0: samples=285184 (17.82s) | speaker: embDim=256 norm=1.0000 |
              diariz: frames=293 distinctClasses=1
  ```
  The 17.82 s turn (< 19.26 s fed) is a **real VAD speech-end** firing at the
  silence boundary — turn segmentation, the 256-d L2-normalized speaker
  embedding, and the 293-frame diarizer all ran in-process.
- **Wake-word** (`wakewordSelfTest`, "hey eliza" clip vs silence):
  `posMax=1.0000 negMax=0.0000`.

The JS-side consumer (`JniVoicePipeline`) has a host unit test
(`packages/ui/src/voice/jni-voice-pipeline.test.ts`, 5 cases): lifecycle,
runtime-unavailable refusal, frame batching (one bridge call per ~1 s), turn
embedding/label decode, and the confident-bystander suppression gate.

The platform-agnostic agent-side consumer
(`plugins/plugin-local-inference/src/services/voice/audio-frame-consumer.ts`)
also has its host unit test + the real-model smoke
(`packages/app-core/scripts/voice-attribution-smoke.ts`), shared by both
transports.

## On-device verification surface

`window.__jniVoice` (installed on Android by `main.tsx` →
`installJniVoiceHarness`) drives the in-process pipeline from CDP:

```
window.__jniVoice.start()   → open native pipeline + start mic + pump
window.__jniVoice.status()  → { running, framesSent, turnsObserved, abi, recentTurns }
window.__jniVoice.stop()    → stop capture, flush the open turn, free handles
```

## Legacy: musl bun-agent transport (AOSP build only)

Before the JNI host, the four classifiers ran in the **embedded bun agent**
(a separate musl process), reached from the WebView by POSTing batched frames to
`POST /api/voice/audio-frames` (`AudioFramePump` →
`LiveDiarizationSession` → `AudioFrameConsumer`). That path dlopened standalone
musl libs (`libsilero_vad.so`, `libvoice_classifier.so`, cross-compiled with
`zig cc --target=aarch64-linux-musl`) via bun:ffi, pointed at by the
`ELIZA_SILERO_VAD_LIB` / `ELIZA_VOICE_CLASSIFIER_LIB` env vars
`ElizaAgentService` exports when those `.so` are present in `nativeLibraryDir`.

This transport is **superseded for the normal APK** by the JNI/bionic host
above. The standalone musl voice `.so` and their zig cross-build script
(`packages/native/scripts/build-voice-libs-android-musl.mjs`) have been removed.
The musl `libllama.so` (the text agent — a separate concern) is untouched, and
the bun-agent voice path remains available on the privileged AOSP build (out of
scope here — to be unified with the JNI host later).
