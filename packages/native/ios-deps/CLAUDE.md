# @elizaos/ios-native-deps

macOS cross-build harness for native dependencies embedded in iOS runtimes.

## Role

This private package builds two signed-app inputs:

- `llama.cpp/dist/LlamaCpp.xcframework` from the pinned elizaOS llama.cpp fork, including device and Apple-silicon simulator slices.
- `sqlite-vec/dist/SqliteVec.xcframework` for on-device vector search.

`VERSIONS` is the pin source of truth. Build scripts own checkout, platform flags, headers, static library combination, framework assembly, and validation. Consumers stage the produced xcframeworks through their Podspec/build pipelines; they must not depend on machine-local absolute paths.

## Layout

```
VERSIONS                    dependency pins
llama.cpp/
  build-ios.sh              device/simulator build and xcframework assembly
  shim/                     public Swift/C bridge
  README.md                 detailed flags and artifact checks
sqlite-vec/
  build-ios.sh              sqlite-vec framework build
  README.md                 sqlite-vec-specific workflow
package.json                macOS-gated workspace scripts
```

## Commands

```bash
bun run --cwd packages/native/ios-deps build:llama-cpp
bun run --cwd packages/native/ios-deps build:llama-cpp:device
bun run --cwd packages/native/ios-deps build:llama-cpp:simulator
bun run --cwd packages/native/ios-deps build:sqlite-vec
bun run --cwd packages/native/ios-deps build:sqlite-vec:device
bun run --cwd packages/native/ios-deps build:sqlite-vec:simulator
bun run --cwd packages/native/ios-deps lint:check
bun run --cwd packages/native/ios-deps format:check
bun run --cwd packages/native/ios-deps clean
```

These builds require macOS, full Xcode, and CMake. `LLAMA_CPP_REPO`, `ELIZA_IOS_MIN_VERSION`, and the documented force-build flags modify the build inputs; record them with evidence.

## Change rules

- Pin immutable commits or release tags in `VERSIONS`; do not make release output depend on an unrecorded branch tip.
- Update scripts, headers, Pod consumers, and verification together when the native ABI or artifact layout changes.
- Preserve device and simulator slices and confirm architecture/platform metadata with Apple tooling.
- Keep Metal resources and public headers inside the xcframework expected by the consuming Pod.
- Treat sqlite-vec and llama.cpp as separate artifacts with separate opt-in/reuse rules.
- Fail when a requested slice or required symbol is absent. Do not reuse an artifact without validating its pin, platform, and contents.
- Do not commit generated build trees or xcframeworks unless a release process explicitly requires it.

## Verification

Follow the repository-wide standard in the [root CLAUDE.md](../../../CLAUDE.md). Build every affected slice on macOS, inspect the xcframework metadata, architectures, exported symbols, headers, and embedded Metal assets, then install the consuming iOS app and exercise the real native operation.

