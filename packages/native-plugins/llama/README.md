# @elizaos/capacitor-llama

On-device llama.cpp runtime for Milady iOS and Android builds.

This package ships the **TypeScript contract**, **Capacitor plugin
registrations**, and **Swift / Kotlin wrapper classes** that Milady's
`LocalInferenceEngine` will switch to on native platforms. The actual
llama.cpp native code is **not** vendored here — it has to be built from
source and linked in a release build. This README documents that process.

Until the native bindings are compiled in, every method rejects with a
clear "unavailable" error and the Milady UI falls back to the server-side
engine (desktop Bun process, or a paired companion instance).

---

## Why this isn't a one-line install

llama.cpp is a C/C++ library. To run it on mobile you need architecture-
specific compiled binaries plus a narrow FFI surface. There are no reliable
"npm install llama-cpp-ios" packages — Jan.ai, PocketPal, and every other
mobile llama app builds its own.

## iOS — build llama.cpp as an xcframework

1. Clone llama.cpp at a known-good tag:

   ```bash
   git clone https://github.com/ggerganov/llama.cpp.git ~/src/llama.cpp
   cd ~/src/llama.cpp
   git checkout b4500   # or whatever matches node-llama-cpp 3.18.x
   ```

2. Build the xcframework for iOS device + simulator:

   ```bash
   # Device (arm64)
   cmake -B build-ios -G Xcode -DLLAMA_METAL=ON -DLLAMA_ACCELERATE=ON \
     -DCMAKE_SYSTEM_NAME=iOS -DCMAKE_OSX_DEPLOYMENT_TARGET=15.0 \
     -DCMAKE_OSX_ARCHITECTURES=arm64
   cmake --build build-ios --config Release -- -sdk iphoneos

   # Simulator (arm64 + x86_64)
   cmake -B build-sim -G Xcode -DLLAMA_METAL=OFF \
     -DCMAKE_SYSTEM_NAME=iOS -DCMAKE_OSX_DEPLOYMENT_TARGET=15.0 \
     -DCMAKE_OSX_ARCHITECTURES="arm64;x86_64"
   cmake --build build-sim --config Release -- -sdk iphonesimulator

   xcodebuild -create-xcframework \
     -framework build-ios/Release-iphoneos/llama.framework \
     -framework build-sim/Release-iphonesimulator/llama.framework \
     -output llama.xcframework
   ```

3. Drop the resulting framework into this package:

   ```bash
   mv llama.xcframework eliza/packages/native-plugins/llama/ios/Frameworks/
   ```

4. Uncomment the `s.vendored_frameworks` line in
   `ElizaosCapacitorLlama.podspec` and run `pod install` in `apps/app/ios`.

5. In `LlamaPlugin.swift`, flip `llamaBackendAvailable` to `true` and
   replace the `TODO(llama.cpp)` blocks with real calls:
   - `llama_backend_init()`
   - `llama_load_model_from_file`
   - `llama_new_context_with_model`
   - `llama_sampler_chain_add` (temperature + top-p)
   - `llama_decode` in a loop
   - `llama_token_to_piece` for streaming

## Android — CMake + JNI wrapper

1. Clone llama.cpp sources into `android/src/main/cpp/llama.cpp/`.

2. Add `android/src/main/cpp/CMakeLists.txt`:

   ```cmake
   cmake_minimum_required(VERSION 3.22)
   project(llama_jni)

   add_subdirectory(llama.cpp)
   add_library(llama_jni SHARED jni_bridge.cpp)
   target_link_libraries(llama_jni llama log android)
   ```

3. Write `android/src/main/cpp/jni_bridge.cpp` with `extern "C"` wrappers:

   ```cpp
   extern "C" JNIEXPORT jlong JNICALL
   Java_ai_eliza_plugins_llama_LlamaPlugin_nativeLoadModel(
       JNIEnv* env, jobject, jstring path, jint ctx_size, jboolean use_gpu) {
     // ... llama_load_model_from_file and friends ...
   }
   ```

4. Uncomment the `externalNativeBuild` + `ndk { abiFilters ... }` blocks
   in `android/build.gradle`.

5. Add `System.loadLibrary("llama_jni")` to `LlamaPlugin.kt`'s companion
   `init` block, flip `NATIVE_BACKEND_AVAILABLE` to `true`, and replace
   the `TODO(llama.cpp)` comments with JNI calls.

## Wiring into Milady's runtime

Once the native binaries are linked, the standalone engine in
`@elizaos/app-core` picks up the Capacitor plugin automatically via the
`localInferenceLoader` runtime service. See
`eliza/packages/app-core/src/services/local-inference/active-model.ts`.

On mobile builds, the Capacitor plugin should register itself as the
runtime loader during app bootstrap:

```ts
import { Llama } from "@elizaos/capacitor-llama";

runtime.registerService("localInferenceLoader", {
  async loadModel({ modelPath }) {
    await Llama.loadModel({ modelPath });
  },
  async unloadModel() {
    await Llama.unloadModel();
  },
  currentModelPath() {
    // `isLoaded()` is async so we cache the last known state — or make
    // `currentModelPath` async in the loader contract.
    return null;
  },
});
```

## Scope notes

- **GGUF model files** reach the device either via
  `@elizaos/app-core`'s downloader writing to the app sandbox, or via
  user-initiated download from a paired desktop instance. Models are *not*
  bundled in the app binary — they're far too large.
- **Streaming** uses Capacitor's `notifyListeners("token", ...)`. The JS
  plugin contract exposes this as `addListener("token", ...)`.
- **Embeddings and TTS** are out of scope for this plugin. Those continue
  to run server-side.

## Build checklist (for the engineer wiring this up)

- [ ] Compile `llama.xcframework` and drop into `ios/Frameworks/`
- [ ] Uncomment `s.vendored_frameworks` in the podspec
- [ ] Fill in iOS `TODO(llama.cpp)` blocks in `LlamaPlugin.swift`
- [ ] Flip `llamaBackendAvailable` to `true`
- [ ] Add `llama.cpp/` sources + `CMakeLists.txt` + `jni_bridge.cpp` on Android
- [ ] Uncomment `externalNativeBuild` + `abiFilters` in `android/build.gradle`
- [ ] Fill in Android `TODO(llama.cpp)` blocks in `LlamaPlugin.kt`
- [ ] Flip `NATIVE_BACKEND_AVAILABLE` to `true`
- [ ] Test a 1B GGUF load + generate on a real iPhone and Pixel
- [ ] Register the plugin as `localInferenceLoader` in the Capacitor bootstrap
- [ ] Add a mobile-specific smoke test under `apps/app/test`

## Licensing

llama.cpp is MIT. Vendoring the xcframework / source tree is fine for
the Milady build; keep the upstream copyright notice in the distributed
binaries.
