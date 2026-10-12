# Kokoro voice for Android consumers

Android library for on-device English speech with Kokoro-82M. eSpeak NG makes
the phonemes and the Kokoro head of `libelizainference` makes 24 kHz audio in
the app process. It needs no agent, inference server, account, or network.

```java
KokoroVoice voice = KokoroAssets.install(context).open(); // worker thread
KokoroVoice.Audio audio = voice.synthesize("Hello.", 1.0f);
```

For transcription, `ai.eliza.speech.LocalTranscriber` in `../local-speech` uses
the Android on-device recognizer when one is available, else Whisper tiny.en.

## Build

Generate the native inputs and the hash-pinned model bundle (NDK 28.2,
arm64-v8a and x86_64). Pins are in `inputs.json`; `--model-cache` is searched
before Hugging Face.

```sh
ANDROID_HOME=~/Library/Android/sdk node packages/app/scripts/kokoro-voice/build-native.ts \
  --workspace /path/to/build/kokoro-voice [--model-cache /path/to/models]
```

A consumer Gradle library sets `ext.elizaKokoroSourceDir` to this directory and
applies `consumer.gradle`. Optional properties: `elizaKokoroNativeDir`,
`elizaKokoroFfiIncludeDir`, `elizaKokoroInferenceLibDir`, and
`elizaKokoroPackageInference=false` when the app already packages
`libelizainference.so`. The build fails if a generated file differs from
`native/build-record.json`.

The app module should store the model plain (`androidResources { noCompress 'gguf', 'bin' }`).
A compressed 160 MB GGUF makes the first `KokoroAssets.install` slow.

## Voice preset

The bundle uses the stock `af_bella` preset. The `af_sam` preset in
`elizaos/eliza-1` is not usable: its 510 style rows are identical and its
decoder style values have about 3.7 times the spread of the stock presets, so
Kokoro makes near-silent audio (Whisper word error rate 1.03 on device).

## Qualify on a device

`packages/app/scripts/kokoro-voice/qualify` speaks 25 sentences, transcribes
them with Whisper tiny.en on the device, and reports word error rate and
real-time factor. `localSpeechModule` is a local-speech consumer module made
with `packages/app/scripts/local-speech` (`install-generated --module`).

```sh
packages/app/platforms/android/gradlew -p packages/app/scripts/kokoro-voice/qualify \
  -PlocalSpeechModule=/path/to/local-speech :app:connectedDebugAndroidTest
```

The report is `Android/data/ai.eliza.voicequalify/files/kokoro-roundtrip.json`
on the device. Pass `-Pandroid.testInstrumentationRunnerArguments.voice=<file>`
to try another preset.

## Licenses

The Java and C++ sources here are MIT. `libkokorovoicejni.so` links eSpeak NG
(GPL-3.0-or-later) statically, so an APK that ships it must meet the GPL. The
bundle includes `notices/espeak-ng-COPYING`. Kokoro weights are Apache-2.0.
