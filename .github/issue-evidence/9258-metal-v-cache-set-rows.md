# Issue 9258: Metal custom V-cache SET_ROWS

Date: 2026-06-24

Hardware: Apple M4 Max, Metal backend `MTL0`

Native llama.cpp fork revision:

```text
plugins/plugin-local-inference/native/llama.cpp @ 6e83e4b9b808bc21100c7846fcc1acd0a0fa674c
```

The branch was rebased onto current `origin/develop` before the verification
below. The fix adds Metal `SET_ROWS` and copy/dequant coverage for manually
selected custom V-cache types `tbq3_0`, `tbq4_0`, and `q4_polar`.

## macOS Metal build

```bash
cmake -S . -B build-metal-9258 -G Ninja -DCMAKE_BUILD_TYPE=RelWithDebInfo -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON -DLLAMA_BUILD_TESTS=ON -DLLAMA_BUILD_EXAMPLES=ON -DLLAMA_CURL=OFF
cmake --build build-metal-9258 --target test-backend-ops llama-cli llama-completion llama-server -j 12
```

Result: build completed successfully.

## Metal shader compilation

macOS:

```bash
xcrun -sdk macosx metal -I ggml/src -I ggml/include -I ggml/src/ggml-metal -c ggml/src/ggml-metal/ggml-metal.metal -o /tmp/ggml-metal-9258-reverify.air
```

iOS device SDK:

```bash
xcrun -sdk iphoneos metal -I ggml/src -I ggml/include -I ggml/src/ggml-metal -c ggml/src/ggml-metal/ggml-metal.metal -o /tmp/ggml-metal-9258-ios.air
```

iOS simulator SDK:

```bash
xcrun -sdk iphonesimulator metal -I ggml/src -I ggml/include -I ggml/src/ggml-metal -c ggml/src/ggml-metal/ggml-metal.metal -o /tmp/ggml-metal-9258-ios-sim.air
```

Result: all three shader compiles exited 0. Only pre-existing warning classes
were emitted.

## Backend SET_ROWS tests

```bash
build-metal-9258/bin/test-backend-ops test -b MTL0 -o SET_ROWS -p "(tbq3_0|tbq4_0|q4_polar)"
```

Result: `12/12 tests passed`. The run loaded:

- `kernel_set_rows_tbq3_0_i64`
- `kernel_set_rows_tbq3_0_i32`
- `kernel_set_rows_tbq4_0_i64`
- `kernel_set_rows_tbq4_0_i32`
- `kernel_set_rows_q4_polar_i64`
- `kernel_set_rows_q4_polar_i32`

## Backend CPY/dequant tests

```bash
build-metal-9258/bin/test-backend-ops test -b MTL0 -o CPY -p "(tbq3_0|tbq4_0|q4_polar)"
```

Result: `6/6 tests passed`. The run loaded:

- `kernel_cpy_f32_tbq3_0`
- `kernel_cpy_f32_tbq4_0`
- `kernel_cpy_f32_q4_polar`
- `kernel_cpy_tbq3_0_f32`
- `kernel_cpy_tbq4_0_f32`
- `kernel_cpy_q4_polar_f32`

## Real GGUF CLI smoke tests

Model:

```text
/Users/shawwalters/.eliza/local-inference/models/eliza-1-0_8b.bundle/text/eliza-1-0_8b-128k.gguf
```

Commands:

```bash
build-metal-9258/bin/llama-cli -m /Users/shawwalters/.eliza/local-inference/models/eliza-1-0_8b.bundle/text/eliza-1-0_8b-128k.gguf -p "Metal tbq3 smoke." -n 4 -c 256 -ngl 99 -fa on -ctv tbq3_0 --no-display-prompt --single-turn --simple-io --no-warmup --no-perf --no-show-timings
build-metal-9258/bin/llama-cli -m /Users/shawwalters/.eliza/local-inference/models/eliza-1-0_8b.bundle/text/eliza-1-0_8b-128k.gguf -p "Metal tbq4 smoke." -n 4 -c 256 -ngl 99 -fa on -ctv tbq4_0 --no-display-prompt --single-turn --simple-io --no-warmup --no-perf --no-show-timings
build-metal-9258/bin/llama-cli -m /Users/shawwalters/.eliza/local-inference/models/eliza-1-0_8b.bundle/text/eliza-1-0_8b-128k.gguf -p "Metal q4 polar smoke." -n 4 -c 256 -ngl 99 -fa on -ctv q4_polar --no-display-prompt --single-turn --simple-io --no-warmup --no-perf --no-show-timings
```

Result: all three commands loaded the real model, generated four tokens, and
exited 0. This covers the manual `--cache-type-v` path through Metal
`SET_ROWS`, graph fallback dequantization, and stock flash attention.

## llama-completion smoke tests

```bash
build-metal-9258/bin/llama-completion -m /Users/shawwalters/.eliza/local-inference/models/eliza-1-0_8b.bundle/text/eliza-1-0_8b-128k.gguf -p "Metal completion tbq3 smoke." -n 4 -c 256 -ngl 99 -fa on -ctv tbq3_0 --no-warmup --no-perf
build-metal-9258/bin/llama-completion -m /Users/shawwalters/.eliza/local-inference/models/eliza-1-0_8b.bundle/text/eliza-1-0_8b-128k.gguf -p "Metal completion tbq4 smoke." -n 4 -c 256 -ngl 99 -fa on -ctv tbq4_0 --no-warmup --no-perf
build-metal-9258/bin/llama-completion -m /Users/shawwalters/.eliza/local-inference/models/eliza-1-0_8b.bundle/text/eliza-1-0_8b-128k.gguf -p "Metal completion q4 polar smoke." -n 4 -c 256 -ngl 99 -fa on -ctv q4_polar --no-warmup --no-perf
```

Result: all three commands exited 0 with no Metal abort.

## Node/web llama-server smoke tests

For each cache type, the server was started on `127.0.0.1:19058`:

```bash
build-metal-9258/bin/llama-server -m /Users/shawwalters/.eliza/local-inference/models/eliza-1-0_8b.bundle/text/eliza-1-0_8b-128k.gguf --host 127.0.0.1 --port 19058 -c 256 -ngl 99 -fa on -ctv <tbq3_0|tbq4_0|q4_polar> --no-warmup --no-webui
curl -sS --fail -X POST http://127.0.0.1:19058/completion -H 'Content-Type: application/json' -d '{"prompt":"server smoke","n_predict":4,"stream":false}'
```

Result: all three HTTP requests returned JSON with `tokens_predicted: 4` and
exit status 0. Each server loaded the real GGUF model on Metal and shut down
cleanly.

## iOS slice and app verification

Device and simulator static slices:

```bash
ELIZA_MTP_FORCE_REBUILD=1 node packages/app-core/scripts/build-llama-cpp-mtp.mjs --target ios-arm64-metal
ELIZA_MTP_FORCE_REBUILD=1 node packages/app-core/scripts/build-llama-cpp-mtp.mjs --target ios-arm64-simulator-metal
```

Result: both targets built successfully and wrote 5 archives plus headers and
`CAPABILITIES.json`:

- `/Users/shawwalters/.eliza/local-inference/bin/mtp/ios-arm64-metal`
- `/Users/shawwalters/.eliza/local-inference/bin/mtp/ios-arm64-simulator-metal`

XCFramework packaging:

```bash
rm -rf /tmp/LlamaCpp-9258.xcframework
node packages/app-core/scripts/ios-xcframework/build-xcframework.mjs --output /tmp/LlamaCpp-9258.xcframework --verify
```

Result: exited 0. Kernel-symbol audit passed for device and simulator,
runtime-symbol audit passed for device and simulator, and the produced
xcframework reported slices `ios/arm64` and `ios-simulator/arm64`.

iOS simulator app build:

```bash
bun run --cwd packages/app build:ios:local:sim
```

Result: exited 0. The build reused the rebuilt MTP slices, generated and
verified the eliza-built `LlamaCpp.xcframework`, archived the stock npm
framework out of `FRAMEWORK_SEARCH_PATHS`, installed pods, and completed
`xcodebuild` for `generic/platform=iOS Simulator` with `** BUILD SUCCEEDED **`.

Physical iOS device smoke:

```bash
ELIZA_IOS_DEVELOPMENT_TEAM=25877RY2EH node packages/app-core/scripts/ios-xcframework/run-physical-device-smoke.mjs --xcframework /tmp/LlamaCpp-9258.xcframework --report /tmp/9258-ios-device-smoke-rerun.json --xcodebuild-arg -allowProvisioningUpdates --keep-temp
```

Result: passed on physical iPhone. The tool detected the connected iPhone 16
Pro Max, built and signed the generated `ElizaIosRuntimeSmokeHost` XCTest host,
installed/launched it on device, and completed with `** TEST SUCCEEDED **` plus
`[ios-smoke] physical-device XCTest PASS`.

Executed tests:

- `testLibElizaInferenceAbiV1CallsMatchHeader`: passed.
- `testLlamaKernelAndVoiceSymbolsResolve`: passed.
- `testMetalDeviceIsAvailableOnPhysicalIos`: passed.
- `testOptionalElizaTextGenerationBenchmark`: skipped as expected because this
  runtime-symbol smoke did not bundle a benchmark model.

The generated JSON report was kept under `/tmp` rather than committed because
it includes local device diagnostics.

## Focused package tests

```bash
bun run --cwd plugins/plugin-native-llama test
bun run --cwd plugins/plugin-local-inference test
```

Results:

- `plugins/plugin-native-llama`: 4 files passed, 35 tests passed.
- `plugins/plugin-local-inference`: 201 files passed, 1 skipped; 2065 tests
  passed, 13 skipped.

## Repo verification

```bash
bun install
bun run verify
```

Results:

- `bun install` completed successfully.
- `bun run verify` completed successfully with `509 successful, 509 total`
  tasks in `9m43.025s`.

Notes:

- `bun run verify` emitted unrelated Biome warnings in existing tests
  (`Function` type in `plugin-agent-orchestrator`, non-null assertions in
  scheduling/finance tests), but exited 0.
- The iOS full-Bun simulator build emitted an existing simulator-only notice
  that the full Bun device/App Store engine still imports forbidden symbols;
  the simulator build continued and succeeded. This is unrelated to
  `LlamaCpp.xcframework` and did not block simulator validation.
