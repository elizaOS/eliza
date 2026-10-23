# Paradee voice for Android consumers

Android library for on-device English speech and transcription in the app
process, with `libelizainference` (llama.cpp based). There is no ONNX, agent,
inference server, account or network use.

- **Speech:** Paradee-8M v1.0 (one voice, `af_heart`, 24 kHz). Native misaki
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
ParadeeVoice voice = bundle.openVoice();
ParadeeVoice.Audio audio = voice.synthesize("Hello.", 1.0f);
NativeAsr asr = new NativeAsr(asrBundleDir); // a directory with asr/
String text = asr.transcribe(pcm16kMono);
if (asr.supportsStreaming()) {
  try (NativeAsr.Stream stream = asr.openStream(48000)) {
    stream.feed(chunk);              // audio thread: buffers only
    String running = stream.partial(); // worker thread
    String finalText = stream.finish();
  }
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

`cancel()` on either object stops the running call from another thread; that
call throws `java.util.concurrent.CancellationException`. `trimMemory()` frees
the weights and keeps the object; the next call reloads them.

The JNI bridge is the app's `app/src/main/elizavoice-jni`, built here as
`libparadeevoicejni.so` for `ai.eliza.voice.VoiceNative` with only the voice
natives. Its `JNI_OnLoad` registers the methods and is its only export.

## Capacitor plugin

Set `ext.elizaParadeeCapacitor = true` before you apply `consumer.gradle` to add
`ParadeeVoicePlugin` (`capacitor/`). The build must include `:capacitor-android`.
Register the plugin in the activity. The JavaScript name is `ParadeeVoice`:

- `status()` gives `{ speech, transcription }`. `transcription` is `android`,
  `asr` or `none`. It also starts the bundle install and the model load.
- `synthesize({ requestId, text, speed })` gives a 16-bit WAV in `audioBase64`,
  `sampleRate`, `seconds` and `ms`.
- `transcribe({ requestId, pcm16Base64, sampleRate: 16000 })` gives `text`,
  `engine`, `fellBack`, `demoted` and `ms`. The input is at most one minute.
- `cancel({ requestId })` stops that request. It rejects with `CANCELLED`.

Transcription uses `OnDeviceRecognizer` first when Android 13 or later has an
installed on-device English model. That class feeds the recording through
`RecognizerIntent.EXTRA_AUDIO_SOURCE` and needs `RECORD_AUDIO`. When the
recognizer fails, or returns no words for audio that holds speech, `NativeAsr`
transcribes the recording. A timeout or empty answer turns the recognizer off
for the process. The models and their two worker threads belong to the process.

`Wer` is the device copy of `packages/app/scripts/voice-quality/wer.ts` (same normalization
and word error count) for consumer quality gates.

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
`libelizainference.so`. The build fails if a generated file differs from
`native/build-record.json`.

Store the model uncompressed in the APK (`androidResources { noCompress 'gguf', 'lex' }`).
A host made by `scripts/mobile/android/consumer-host.mjs` sets this in its profile:
`"androidResources": { "noCompress": ["gguf", "lex"] }`.

## Licenses

The Java and C++ sources here are MIT. Paradee-8M v1.0 weights
(sahilmahendrakar/Paradee-8M-v1.0) and the misaki lexicon data
(hexgrad/misaki) are Apache-2.0. Phonon-2 weights (FermionResearch/Phonon-2,
derived from NVIDIA parakeet-tdt-0.6b-v3) are CC-BY-4.0: show the attribution
and ship Fermion's NOTICE (also embedded in the GGUF as `parakeet.notice`). The
NOTICE lists CHiME-6 (CC-BY-SA-4.0) and SPGISpeech (Kensho terms) training
audio; that is flagged for review, not a blocker. `libelizainference.so` links eSpeak NG
1.52.0 (GPL-3.0-or-later) statically as the out-of-lexicon fallback, so an APK
that ships it must meet the GPL. The bundle `notices/` carry the eSpeak NG
license, and the misaki (Apache-2.0) and spaCy (MIT) notices for the G2P
rules ported from them.
