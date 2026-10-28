# Android bindings for local inference

Android bindings owned by `@elizaos/plugin-local-inference`, using the same
`libelizainference` build as text and embeddings. `InferenceSession` owns one
lazy native context for text, embeddings, Paradee TTS and Phonon-2 ASR.
`trimMemory()` cancels active work and releases native models; the next call
reloads them. `close()` is terminal. Native callers own scheduling and should
trim on Android memory pressure; consumers of the process-wide session release
their own client instead (below).

`supportsStreaming()` checks the engine without opening a context or loading
models. `speechSampleRate()` loads only speech output when needed and returns
its actual rate. Consumers can use these methods on the shared session instead
of opening a separate `ParadeeVoice` handle to check output capabilities.
Use `prepareSpeech()` when readiness requires both speech output and recognition
models to initialize. It uses the same context and reports initialization or
cancellation failures. `isSpeechLoaded()` observes the actual output wrapper
without loading anything, including after a cancelled first load. Trimming or
closing the session clears that state.

`VoiceAssets.sharedInference(context)` returns the process-wide session for the
installed bundle (on a worker thread). Each native consumer in the process uses its
own `client()`: calls still serialize on the session, but a client's `cancel()` fences
only that client's calls (it interrupts the native call only while it is the
client's), and its `release()` drops only its own hold on the models, which are freed
once no client holds them. One consumer's idle or memory-pressure release therefore
never cancels or unloads another's speech, and no consumer cancels, trims or closes
the shared session itself. `openVad()` opens a Silero VAD detector (16 kHz,
512-sample windows) on a small VAD-only context under the same owner and lock-free
with respect to speech: capture keeps running while a synthesis stream holds the
session (full duplex), and `cancel()` never fences input. `trimMemory()` keeps open
detectors and frees an idle VAD context; `close()` retires every detector.

## Shared native speech pipeline

These classes are the common Android speech path for every host; products supply
only identity and bridge wiring:

- `LocalSpeechEngine` serially owns one lazy backend. `SessionSpeech.shared(context)`
  is the validated backend over the shared session: 0.1–60 s finite recognition
  input (silence transcribes to nothing), bounded reviewed text, finite non-silent
  24 kHz output, per-chunk stream validation with zeroing, and failures held until
  the native stream returns. Each backend is its own session client: cancelling
  it never fences another consumer, and releasing it drops only its own hold.
  Because the models are freed only once no client holds them, a host that keeps
  a long-lived `SessionSpeech` must `close()` it on its own idle timeout and on
  `onTrimMemory` pressure; otherwise another consumer's pressure release cannot
  unload the shared models.
- `StreamingSpeechPlayback` plays streamed chunks through a bounded `SpeechPcmQueue`
  (backpressure paces synthesis to playback; 30 s at 24 kHz is the usual bound)
  with `AudioTrackSpeechOutput`; stop drops and zeroes unplayed audio and cancels
  synthesis; exactly one terminal outcome is reported.
- `SpeechAudioFocus` / `SpeechAudioFocusPolicy`: transient duckable assistant-speech
  focus held only while speech plays, no speech over a ringing phone or call, and
  call-mode watching that stops speech and conversation capture.
- `LiveVoiceCapture` reads 16 kHz microphone PCM (the echo-cancelled communication
  source for a conversation when the device has a canceller, `LiveCaptureSource`),
  runs the shared VAD on every 32 ms window, gates segments with `LiveVadGate`
  (pre-roll, ~512 ms hangover) and hands each segment's frames and edges to the
  host. `LiveCaptureAdmission` and `LiveCaptureResource` fence permission callbacks,
  blocked starts, pause and stale stops. Nothing is written to storage.
- `LiveCaptureController` is the host-neutral owner of one plugin's live capture:
  it reserves admission before the permission prompt, replaces a running capture,
  warms the agent's streaming ASR session before the microphone opens, publishes
  cancellation before native startup, delivers events only while the host's
  lifecycle gate for the capture's epoch holds, applies the Stop cutoff and
  reports whether the agent acknowledged the close, and interrupts capture for a
  call without blocking. A plugin keeps only its bridge, permission prompt and
  lifecycle (`Host`, `Started`, `Stopped`).
- `LiveSegmentPipe` routes VAD segments to `POST /api/asr/local-inference/live`
  over a host `Transport` bound to the owner who started the capture (bounded
  queue, cutoff, discard, acknowledged close, no retry). Its `check()` throws once
  the owner, runtime or enrollment changed, so no audio or cleanup reaches another
  owner. `BufferedStreamExchange` is the bounded, deadline-limited request over a
  cancellable local agent stream that such a transport uses.
- `VoiceLatencyTrials` / `VoiceLatencyProbe` measure a conversation turn from the
  capture timestamp of the last speech window to the platform presentation time of
  the first audible response sample (AudioTrack or MediaPlayer timestamps; head
  position only as a labelled fallback), with stage marks, cold/overlap/abandon
  outcomes, network/thermal state and the build/engine/model identity. Hosts name
  the export document and their build with `VoiceLatencyProbe.configureHost`.

`node --test packages/app/scripts/paradee-voice/speech-pipeline-contract.test.mjs`
runs the host-JVM contracts and compiles the library against Android 36. They are
not AudioTrack, AudioRecord, model, device-audio or latency evidence.

The optional `ElizaInferencePlugin` Capacitor transport provides one process
queue, idle unloading and Android memory-pressure handling, through its own client
of the shared session. Enable it with
`elizaInferenceCapacitor=true` and register `ElizaInferencePlugin` with the host.
The legacy `elizaParadeeCapacitor` flag and `ParadeeVoicePlugin` name select the
same owner. Existing `ai.eliza.voice` Java APIs remain source compatible;
new code should use `InferenceSession` instead of opening independent handles.
The old app-side Gradle path forwards here. The public `Wer` helper and legacy Android
on-device recognizer API remain available. The Capacitor transcription route
uses only Phonon-2 through `InferenceSession`, with the same request queue and
cancellation owner. Missing native assets or a failed transcription report an
error; they never select the platform recognizer or a cloud provider.

The Eliza app uses its existing `ElizaBionicInferenceServer` shared context.
Hosts using that server should route speech through it. The optional Capacitor
transport is for downstream consumers without that server.

- **Speech:** Paradee-8M v1.1 (one voice, `af_heart`, 24 kHz). Native misaki
  G2P makes the phonemes: the misaki lexicon and rules, with eSpeak NG only
  for words outside the lexicon.
- **Transcription:** the ASR head of `libelizainference` with Phonon-2
  (Parakeet-TDT 0.6B, five-value weights) at `<bundle>/asr/phonon-2-fv5.gguf`:
  batch (16 kHz mono in) and streaming (any rate). Phonon-2 is the only ASR
  model; the `mobile-voice` catalog record pins it. `VoiceNative` sets
  `ELIZA_ASR_BACKEND=ggml` before it loads the library. The GGUF is not
  published; build it with `bun packages/app/scripts/voice/build-phonon2-gguf.ts`
  (it converts the pinned source and checks every sha256). Use `--help` for paths.

To build the unpublished ASR model, initialize the native submodule and use a
Python environment with the native `gguf-py` package, `zstandard`, and `librosa`:

```bash
python3 -m venv .cache/phonon-python
.cache/phonon-python/bin/pip install ./plugins/plugin-local-inference/native/llama.cpp/gguf-py zstandard librosa
bun packages/app/scripts/voice/build-phonon2-gguf.ts --python .cache/phonon-python/bin/python
```

The default output is `.cache/phonon-2/bundle/asr/`, with the GGUF, NOTICE,
and weight license. Set `ELIZA_VOICE_BUNDLE_FROM=.cache/phonon-2/bundle`
when staging. This command builds ASR only; TTS and VAD still need their
pinned files. It performs no upload or device installation.

```java
VoiceAssets.Bundle bundle = VoiceAssets.install(context); // worker thread
try (InferenceSession inference = bundle.openInference()) {
  ParadeeVoice.Audio audio = inference.synthesize("Hello.", 1.0f);
  String text = inference.transcribe(pcm16kMono);
  inference.trimMemory(); // reloadable, unlike close()
}
```

With native ABI 19, `ParadeeVoice.supportsStreaming()` admits
`synthesizeStream(text, speed, sink)`. The sink receives each model chunk before
the next chunk is synthesized, in arrays of at most 24,000 samples. It runs on
the caller's worker and provides backpressure. An empty array with `complete`
marks the end; the method return is authoritative. Return false or call `cancel()`
to cancel, and discard queued playback after any error. The sink may not reenter
synthesis, trimming or close on this voice. A separate thread may close it;
close cancels and waits until callbacks have retired before freeing the context.
Cancellation retires calls already waiting for the synthesis lock. A fresh call
after cancellation may start again. Consumers must also fence their own owner and
turn generations and keep playback queues bounded. No PCM needs to cross a
renderer bridge. This API does not report heard text or qualify physical playback.

`cancel()` on the session or legacy handles stops the running call from another thread; that
call throws `java.util.concurrent.CancellationException`. `trimMemory()` frees
the weights and keeps the object; the next call reloads them.

The JNI bridge is the app's `app/src/main/elizavoice-jni`, built here as
`libparadeevoicejni.so` for `ai.eliza.voice.VoiceNative` with the full fused inference
native API. Its `JNI_OnLoad` registers the methods and is its only export.

For text and embeddings, native hosts can construct `new InferenceSession(bundleDir)`
with a complete libelizainference bundle. The default voice assets and Capacitor
installer contain speech models only; text and embedding calls require the
corresponding models and fail explicitly when they are unavailable.

## Build

Generate the native inputs and the hash-pinned bundle (NDK 28.2, arm64-v8a and
x86_64, 16 KiB pages). Pins are in `inputs.json` and must equal the fork pins
in `tools/paradee/pins.json`, `tools/misaki-g2p/pins.json`,
`tools/parakeet/pins.json`, and the mobile voice catalog. The builder includes
Paradee, the misaki lexicon, Phonon-2, Silero VAD, and their attribution.
`--python` needs torch plus the conversion dependencies installed above.
`--model-cache` is searched first; every cached file is checked against its pin.

```sh
ANDROID_HOME=~/Library/Android/sdk node packages/app/scripts/paradee-voice/build-native.ts \
  --workspace /path/to/build/paradee-voice [--model-cache /path/to/models] [--python python3]
```

A consumer Gradle library sets `ext.elizaParadeeSourceDir` to this directory
and applies `consumer.gradle`. Optional properties: `elizaParadeeNativeDir`,
`elizaParadeeFfiIncludeDir`, `elizaParadeeInferenceLibDir`, and
`elizaParadeePackageInference=false` when the app already packages
`libelizainference.so` and its admitted `libc++_shared.so`. In that mode the
library packages only its JNI bridge; both runtime libraries remain the host's
responsibility. This also excludes CMake's implicit copies, avoiding duplicate
runtime selection during APK merging. The default still packages both runtime
libraries for standalone consumers such as Sense. The build fails if a generated
file differs from `native/build-record.json`.

Store the model uncompressed in the APK (`androidResources { noCompress 'gguf', 'lex' }`).
A host made by `scripts/mobile/android/consumer-host.mjs` sets this in its profile:
`"androidResources": { "noCompress": ["gguf", "lex"] }`.

## Licenses

The Java and C++ sources here are MIT. Paradee-8M v1.1 weights
(sahilmahendrakar/Paradee-8M-v1.1) and the misaki lexicon data
(hexgrad/misaki) are Apache-2.0. Phonon-2 weights (FermionResearch/Phonon-2,
derived from NVIDIA parakeet-tdt-0.6b-v3) are CC-BY-4.0: show the attribution
and ship Fermion's NOTICE (also embedded in the GGUF as `parakeet.notice`). The
NOTICE lists CHiME-6 (CC-BY-SA-4.0) and SPGISpeech (Kensho terms) training
audio; that is flagged for review, not a blocker. `libelizainference.so` links eSpeak NG
1.52.0 (GPL-3.0-or-later) statically as the out-of-lexicon fallback, so an APK
that ships it must meet the GPL. The bundle `notices/` carry the eSpeak NG
license, and the misaki (Apache-2.0) and spaCy (MIT) notices for the G2P
rules ported from them.

## Hosts with an existing native inference server

Set `elizaParadeeAssetsOnly=true` when applying `consumer.gradle` to package only the pinned models and `VoiceBundleAssets` installer. This mode includes no inference session classes, JNI bridge or native library. The Eliza Android app uses this mode through `:voice-assets`; `ELIZA_VOICE_NATIVE_DIR` selects its generated native input directory. Explicit cloud and host-test builds omit these assets.

Admission checks the complete asset inventory against the build record and rejects duplicate paths, extra files and symlinks. Required speech models must also match `inputs.json`; a matching record cannot substitute a different model.

`VoiceAssets.install(context)` delegates to the same installer. The default private directory remains `paradee-voice-v1`. A host may set application manifest metadata `ai.eliza.voice.BUNDLE_DIRECTORY` to a relative private directory; Eliza uses `eliza-1/bundle` for its existing bionic server. The installer validates that directory beneath `filesDir`. It copies and verifies model files but never opens a native context.

Run `bun run test:android-assets` from this package to exercise the installer with real JVM file operations and synthetic model bytes. It requires JDK 17 or newer and `org.json:json:20250517` in the Gradle cache (or `ELIZA_JSON_JAR`). This test does not qualify models or a device.
