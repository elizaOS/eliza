# Android live voice pipeline: `audioFrame` → speaker-attributed turns

This document maps the **end-to-end on-device** path that turns the Android
`audioFrame` PCM stream (see [`AUDIO_FRAMES.md`](./AUDIO_FRAMES.md)) into live,
VAD-segmented, speaker-attributed voice turns, and states precisely what is
verified vs. what remains to wire on the device.

## The pipeline

```
 Android native AudioRecord (plugin-native-talkmode, Kotlin)
   │  emits `audioFrame` Capacitor event: base64 LE-s16 16 kHz mono PCM,
   │  20 ms/frame, { sampleRate, channels, samples, rms, timestamp, frameIndex }
   ▼
 Capacitor WebView (JS renderer)            ──┐  WebView and the embedded bun
   │  TalkMode.addListener("audioFrame", …)   │  AGENT are SEPARATE processes.
   ▼                                          │  The PCM must cross this boundary
 [ WebView → agent transport ]  ◀── GAP ──────┘  (see "Remaining device wiring").
   ▼
 Embedded bun agent process
   │  AudioFrameConsumer.onAudioFrame(frame)
   │    (plugins/plugin-local-inference/src/services/voice/audio-frame-consumer.ts)
   │  1. decodeAudioFramePcm(frame)      base64 LE-s16 → Float32 [-1,1] @16k
   │  2. VadDetector.pushFrame(...)      Silero turn segmentation
   │       on speech-start → begin buffering the turn's PCM (+ pre-roll)
   │       on speech-end   → finalize the turn
   │  3. VoiceAttributionPipeline.attribute(turn PCM)
   │       pyannote diarizer + WeSpeaker encoder + VoiceProfileStore
   │  4. handleLiveVoiceAttribution(runtime, output, opts)
   │       → emits VOICE_TURN_OBSERVED  (merge engine folds speaker → entity)
   │       → folds the speaker decision into a `voiceTurnSignal`
   ▼
 voiceTurnSignal  → the `core.voice_turn_signal` server gate decides
                     whether the agent speaks (owner / bystander / wake word).
```

The bun:ffi native libs the agent dlopens at each model stage:

| Stage | bun:ffi loader | native shared lib |
|---|---|---|
| Silero VAD (turn segmentation) | `vad-ggml.ts` (`SileroVadGgml`) | `libsilero_vad.so` |
| WeSpeaker encoder (speaker embedding) | `encoder-ggml.ts` | `libvoice_classifier.so` |
| pyannote diarizer (segment by speaker) | `diarizer-ggml.ts` | `libvoice_classifier.so` |

Each loads its GGUF (`silero-vad-v5.gguf`, `wespeaker-resnet34-lm.gguf`,
`pyannote-segmentation-3.0.gguf`) from the Eliza-1 bundle layout.

## What is verified (host)

The **consumer module is the verified core**: it is platform-agnostic and runs
wherever the bun:ffi libs are present, including the host.

- **Unit test** (no models, fully injected deps):
  `plugins/plugin-local-inference/src/services/voice/audio-frame-consumer.test.ts`
  — 9 vitest cases. Drives the consumer through a **real `VadDetector`** backed
  by a deterministic scripted Silero, a fake attribution pipeline, and a fake
  runtime. Asserts the base64 LE-s16 decode boundary, one turn per
  speech-start/speech-end, the buffered PCM handed to attribution, the
  `VOICE_TURN_OBSERVED` emission + folded `voiceTurnSignal`, silence → no turn,
  decode-failure drop counting, and the runaway-turn cap.

- **Real-model smoke** (host x86_64, real GGUFs + real native libs):
  `packages/app-core/scripts/voice-attribution-smoke.ts`. The added
  `AudioFrameConsumer` section chunks `freeman.wav` into **863 real
  `audioFrame`-shaped base64 frames** (20 ms each) and feeds them through the
  consumer wired to the **real ggml VAD / WeSpeaker encoder / pyannote
  diarizer**. It segments **1 turn** (276 160 samples), attributes a speaker,
  emits `VOICE_TURN_OBSERVED`, produces a `voiceTurnSignal`, and drops 0 frames.
  Run it:

  ```bash
  bun packages/app-core/scripts/voice-attribution-smoke.ts --models /tmp/voice-models
  ```

This proves the **entire agent-side path** — the same code that runs on the
device once the PCM reaches the agent and the arm64 libs are loadable.

## Remaining device wiring (NOT yet wired on-device)

Two pieces are required to run this fully on the Pixel 9a. Neither is wired yet;
both are mechanical given what is verified above.

### 1. WebView → agent transport for the PCM

`audioFrame` fires in the Capacitor WebView; `AudioFrameConsumer` runs in the
embedded bun agent process. The base64 PCM frames must cross that boundary.
Options, cheapest first:

- **POST the frames to a loopback agent route.** The WebView listener batches a
  few `audioFrame` payloads and `fetch()`es them to a new agent HTTP route
  (e.g. `POST /api/voice/audio-frames`) whose handler calls
  `consumer.onAudioFrame(frame)`. Batching (e.g. 100 ms / 5 frames) keeps the
  request rate sane; the payload is already small (≈856 base64 chars/frame).
- **WebSocket** for a steadier stream if batching latency proves too high.

The consumer is transport-agnostic by design: `onAudioFrame(AudioFrameEvent)`
takes exactly the wire payload, and `pushDecodedFrame(Float32Array, ts)` exists
for transports that decode upstream. Nothing in the consumer assumes Capacitor.

### 2. arm64 voice `.so` packaged in the APK

The bun agent on the device is arm64; it needs arm64 builds of the two voice
libs. These are **cross-compiled and staged** (see below). The remaining step is
to point the loaders at them on-device by exporting, at agent boot on Android:

```
ELIZA_SILERO_VAD_LIB       = <nativeLibraryDir>/libsilero_vad.so
ELIZA_VOICE_CLASSIFIER_LIB = <nativeLibraryDir>/libvoice_classifier.so
```

(`<nativeLibraryDir>` is where Android unpacks `jniLibs/arm64-v8a/*.so` for the
installed app — `context.applicationInfo.nativeLibraryDir`.) The loaders
already honor these env vars first (`vad-ggml.ts`, `encoder-ggml.ts`,
`diarizer-ggml.ts`). No code change to the loaders is needed.

## arm64 cross-compile (done)

Both libs are **pure scalar C with no arch intrinsics** (see each plugin's
`CMakeLists.txt` / `CLAUDE.md`), so the same source list that builds on
x86_64 / riscv64 builds for arm64 unchanged — only the toolchain differs.

A new Android arm64 toolchain file mirrors the existing riscv64 precedent:
`packages/native/cmake/toolchain-android-arm64.cmake`
(targets `arm64-v8a`, API 26).

Build (requires an Android NDK; r23+ has a stable aarch64 sysroot — verified
with NDK 28.2.13676358 at `$ANDROID_HOME/ndk/`):

```bash
export ANDROID_NDK_ROOT=$ANDROID_HOME/ndk/28.2.13676358   # any r23+ NDK

# Silero VAD
cmake -S packages/native/plugins/silero-vad-cpp \
      -B packages/native/plugins/silero-vad-cpp/build-android-arm64 \
      -DCMAKE_TOOLCHAIN_FILE=$PWD/packages/native/cmake/toolchain-android-arm64.cmake \
      -DCMAKE_BUILD_TYPE=Release
cmake --build packages/native/plugins/silero-vad-cpp/build-android-arm64 \
      --target silero_vad_shared -j

# Voice classifier (WeSpeaker encoder + pyannote diarizer)
cmake -S packages/native/plugins/voice-classifier-cpp \
      -B packages/native/plugins/voice-classifier-cpp/build-android-arm64 \
      -DCMAKE_TOOLCHAIN_FILE=$PWD/packages/native/cmake/toolchain-android-arm64.cmake \
      -DCMAKE_BUILD_TYPE=Release
cmake --build packages/native/plugins/voice-classifier-cpp/build-android-arm64 \
      --target voice_classifier_shared -j
```

**Verified output** (both `ELF 64-bit LSB shared object, ARM aarch64`):

- `build-android-arm64/libsilero_vad.so` — exports `silero_vad_open`,
  `silero_vad_process`, `silero_vad_reset_state`, `silero_vad_close`,
  `silero_vad_active_backend` (the exact ABI `vad-ggml.ts` dlopens).
- `build-android-arm64/libvoice_classifier.so` — exports `voice_speaker_open`,
  `voice_speaker_embed`, `voice_speaker_close`, `voice_speaker_distance` (the
  ABI `encoder-ggml.ts` / `diarizer-ggml.ts` dlopen).

`NEEDED` deps are only `libm.so` / `libdl.so` / `libc.so` — all in Android
bionic, so the libs load on any arm64 device with no extra runtime deps.

### Staging into the APK

The build artifacts are copied into the Android jniLibs ABI dir (the same dir
that already holds `libllama.so`, `libggml-cpu.so`, etc.):

```
packages/app-core/platforms/android/app/src/main/jniLibs/arm64-v8a/
  libsilero_vad.so          ← cross-compiled (this work)
  libvoice_classifier.so    ← cross-compiled (this work)
```

These `.so` are **gitignored** (like every other lib in that dir) — they are
build artifacts, regenerated by the cmake commands above, not committed. Gradle
packs everything under `jniLibs/arm64-v8a/` into the APK and unpacks it into the
app's `nativeLibraryDir` at install, which is where the two `ELIZA_*_LIB` env
vars above must point.

## Honesty / scope

- **Verified:** the consumer module + its host unit test + the real-model smoke
  driving the consumer with real GGUF models and real native libs; the arm64
  cross-compile (both `.so` produced, correct ABI, correct exported symbols,
  no exotic deps) and their staging into the jniLibs ABI dir.
- **NOT verified on the device:** the WebView→agent PCM transport (not built)
  and loading the arm64 `.so` inside the on-device bun agent (the env-var wiring
  above is the mechanical remaining step). No "it works on Android" end-to-end
  run was performed — the device is owned by another actor and out of scope here.
```
