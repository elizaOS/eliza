# Local Android speech for app consumers

Shared Java speech engine, bounded passage synthesis, and reproducible no-eSpeak
Sherpa runtime/model tooling. Product microphone UI, permissions, approval policy,
and playback ownership remain with the consumer.

The Android library lives at `../../platforms/android/local-speech`. A consumer
Gradle library can set `ext.elizaSpeechSourceDir` to that directory and apply its
`consumer.gradle`; generated AAR/model inputs stay in the consumer module.

Run tooling outside the pinned source checkout (Linux or macOS):

```sh
python3 packages/app/scripts/local-speech/run.py --workspace /path/to/build/speech acquire-downloads
python3 packages/app/scripts/local-speech/run.py --workspace /path/to/build/speech make-lexicon
python3 packages/app/scripts/local-speech/run.py --workspace /path/to/build/speech build-no-espeak --abi arm64-v8a --ndk "$ANDROID_NDK_HOME" --jobs 2
```

Repeat build/strip for x86_64, then run `verify-source`, `prepare-assets` and
`assemble-runtime`. Run `install-generated --module /path/to/consumer/android/local-speech`
to validate and install both ABIs and models. `--test-assets /path/to/androidTest/assets`
also installs the separate speech fixtures. `--repository` is a convenience for
consumers using `android/local-speech` and `android/app/src/androidTest/assets`.
The runner locks each workspace to prevent concurrent downloads/builds from
corrupting its files. Use separate workspaces for independent builds.

Source/model hashes, license notices, no-eSpeak checks and 16 KiB ELF alignment
remain required. Generated runtimes, model binaries and reports are never source.
The Java module is MIT; dependency notices and model provenance remain in the
pinned manifests. APK assembly does not establish actual speech or device acceptance.

Run `node --test packages/app/scripts/local-speech/speech-passage.test.mjs` for
passage preflight, PCM bounds and cancellation wiping, then qualify actual
microphone/synthesis/playback on the consumer's Android devices.
