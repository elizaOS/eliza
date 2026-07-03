# Issue #11714 — Android elizavoice JNI build gate

## Summary

Fixed the clean-build race where the Android `libelizavoicejni.so` bridge was
registered only when `src/main/jniLibs/arm64-v8a/libelizainference.so` already
existed during Gradle configuration.

Changes made:

- The Android app-core template now probes the configured arm64 source library
  first: `-Peliza.mtp.android.libdir`, `ELIZA_MTP_ANDROID_LIBDIR`, then the
  default `${ELIZA_STATE_DIR:-~/.eliza}/local-inference/bin/mtp/android-arm64-{vulkan,cpu}`
  locations.
- If that source binary exports the fused voice ABI, Gradle enables the
  `elizavoice-jni` CMake bridge even on a clean checkout where `jniLibs` is
  still empty.
- `externalNativeBuild*`, `configureCMake*`, and `buildCMake*` tasks now depend
  on `copyForkLlamaLib`, so CMake links after the source `.so` has been staged
  into `jniLibs`.
- If the binary requires the bridge but the llama.cpp omnivoice header is
  missing, Gradle fails loudly with a submodule checkout instruction instead of
  silently shipping an APK without `libelizavoicejni.so`.
- Cloud/smoke skip builds still bypass the bridge and the fused library copy via
  `ELIZA_ANDROID_SKIP_FORK_LLAMA_LIB=1` / `-PelizaCloudBuild=true`.

## Validation

### App-core Gradle skip-mode configuration

Command:

```bash
ELIZA_ANDROID_SKIP_FORK_LLAMA_LIB=1 ./gradlew :app:tasks --dry-run
```

Directory:

```bash
packages/app-core/platforms/android
```

Result: pass.

Observed log:

```text
[elizavoice-jni] skipped for cloud/smoke build
:app:tasks SKIPPED
BUILD SUCCESSFUL
```

### App-core fail-loud missing-header path

Command:

```bash
./gradlew :app:tasks --dry-run
```

Directory:

```bash
packages/app-core/platforms/android
```

Result: expected fail in this workspace because the existing local
`plugins/plugin-local-inference/native/llama.cpp` submodule has unrelated
deleted `tools/omnivoice/**` files.

Observed error:

```text
[elizavoice-jni] .../app/src/main/jniLibs/arm64-v8a/libelizainference.so exports the fused-voice ABI, but .../plugins/plugin-local-inference/native/llama.cpp/tools/omnivoice/include/eliza-inference-ffi.h is missing. Run git submodule update --init --recursive so the llama.cpp omnivoice headers are checked out.
```

### Source-lib probe path

Command:

```bash
tmpdir=$(mktemp -d /tmp/eliza-11714-libdir.XXXXXX)
printf '%s\n' \
  eliza_inference_wakeword_supported \
  eliza_inference_speaker_supported \
  eliza_inference_diariz_supported \
  > "$tmpdir/libelizainference.so"
ELIZA_MTP_ANDROID_LIBDIR="$tmpdir" ./gradlew :app:tasks --dry-run
```

Directory:

```bash
packages/app-core/platforms/android
```

Initial result before submodule checkout: expected fail in this workspace
because the header checkout was missing, and the error proved the new
configuration-time probe reads the configured source library instead of the old
`jniLibs` location:

```text
[elizavoice-jni] /tmp/eliza-11714-libdir.qxEpe0/libelizainference.so exports the fused-voice ABI, but .../plugins/plugin-local-inference/native/llama.cpp/tools/omnivoice/include/eliza-inference-ffi.h is missing.
```

After running:

```bash
git submodule update --init --recursive plugins/plugin-local-inference/native/llama.cpp
```

the same source-lib probe command passes Gradle configuration:

```text
:app:tasks SKIPPED
BUILD SUCCESSFUL
```

### Native task graph with bridge enabled

Command:

```bash
tmpdir=$(mktemp -d /tmp/eliza-11714-libdir.XXXXXX)
printf '%s\n' \
  eliza_inference_wakeword_supported \
  eliza_inference_speaker_supported \
  eliza_inference_diariz_supported \
  > "$tmpdir/libelizainference.so"
ELIZA_MTP_ANDROID_LIBDIR="$tmpdir" ./gradlew :app:externalNativeBuildDebug --dry-run
```

Directory:

```bash
packages/app-core/platforms/android
```

Result: pass. The dry-run task graph shows `copyForkLlamaLib` before the app
CMake configure/build tasks:

```text
:app:copyForkLlamaLib SKIPPED
:app:preBuild SKIPPED
:app:preDebugBuild SKIPPED
:app:configureCMakeDebug[arm64-v8a] SKIPPED
:app:buildCMakeDebug[arm64-v8a] SKIPPED
:app:externalNativeBuildDebug SKIPPED
BUILD SUCCESSFUL
```

Command:

```bash
ELIZA_MTP_ANDROID_LIBDIR="$tmpdir" ./gradlew :app:assembleDebug --dry-run
```

Result: pass. The assemble dry-run includes `:app:copyForkLlamaLib SKIPPED`
before the app CMake tasks and completes with `BUILD SUCCESSFUL`.

### Generated app Android project

Command:

```bash
ELIZA_ANDROID_SKIP_FORK_LLAMA_LIB=1 ./gradlew :app:tasks --dry-run
```

Directory:

```bash
packages/app/android
```

Result: fail before the `:app` Gradle file is configured, due unrelated
generated-project drift:

```text
Configuring project ':elizaos-capacitor-mlkit-text' without an existing directory is not allowed.
The configured projectDirectory '/home/shaw/milady/plugins/plugin-native-mlkit-text/android' does not exist
```

`packages/app/android` is ignored/generated; the tracked fix is in the
`packages/app-core/platforms/android` template.

## Evidence Matrix

- Android device/APK capture: N/A - no real Android fused `libelizainference.so`
  artifact was available in this workspace. The Gradle source-probe, missing
  header fail-loud path, header-present configuration path, and native task
  graph ordering were validated above; CI/release with the real fused artifact
  should perform the full APK packaging/device check.
- UI screenshots/video: N/A - no UI changed.
- Model trajectories: N/A - no model, prompt, provider, or action behavior
  changed.
- Backend logs: N/A - build-system change only.
- Domain artifacts: Gradle output above proves the source-lib probe and
  fail-loud header guard.

## Review follow-up: white-label repo-root pin

`patchAndroidGradle()` in `packages/app-core/scripts/run-mobile-build.mjs`
rewrites the first `def elizaRepoRoot = ...` line to the absolute checkout root
for white-label builds (`ELIZA_ANDROID_USE_APP_DIR=1`), because the relative
`../../../..` walk overshoots when the android project lives outside the eliza
tree. The original PR head introduced a second variable
(`elizaRepoRootForVoiceBuild`) for the header gate that the pin regex did not
match, so a white-label build with a resolvable fused source lib would have
hard-failed the new header check with a misleading "run git submodule update"
message even with the submodule checked out.

Fixed by hoisting a single `def elizaRepoRoot` shared by the CMake include-dir
argument and the header gate; the existing non-global regex now pins both
consumers. Simulated the mjs replace against the updated template: the pin
lands on the hoisted definition and zero relative-walk definitions remain.

Re-validated all four lanes after the change (this reviewer's M4 Max,
`packages/app-core/platforms/android`, Gradle 9.5.0, dry-run):

- `ELIZA_ANDROID_SKIP_FORK_LLAMA_LIB=1 ./gradlew :app:tasks --dry-run` →
  `[elizavoice-jni] skipped for cloud/smoke build`, BUILD SUCCESSFUL.
- Synthetic 3-token source lib via `ELIZA_MTP_ANDROID_LIBDIR` + header present →
  `:app:externalNativeBuildDebug --dry-run` shows `:app:copyForkLlamaLib` before
  `configureCMakeDebug[arm64-v8a]` / `buildCMakeDebug[arm64-v8a]`, BUILD SUCCESSFUL.
- Same source lib + header missing → configuration fails loudly naming the
  configured source lib, BUILD FAILED (expected).
- No source configured, empty jniLibs → graceful warn skip, BUILD SUCCESSFUL.
