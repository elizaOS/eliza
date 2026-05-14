# @elizaos/ios-native-deps

Cross-build harness for the native dependencies that on-device iOS
runtimes (Capacitor bun-runtime, full Bun engine port) need to link
against:

- **llama.cpp** → `llama.cpp/dist/LlamaCpp.xcframework` (device + simulator
  slices, Metal embedded, baked from the milady-controlled
  [`elizaOS/llama.cpp`](https://github.com/elizaOS/llama.cpp) fork — carries
  Q4_POLAR / QJL1_256 / TBQ4_0 / TBQ3_0 GGML types + Metal/Vulkan/CUDA
  kernels and DFlash spec-decode on top of stock upstream).
- **sqlite-vec** → static lib + headers (vector storage + KNN extension
  that replaces pgvector for the on-device SQLite backend; PGlite cannot
  run inside JSContext on iOS 16.4+ because WebAssembly is gated off).

This package replaces the pre-2026-05-13 layout at
`milady/native/ios-bun-port/vendor-deps/`, which duplicated this tooling
inside the milady workspace. Per the
"milady-depends-100%-on-eliza, eliza-is-ejectable-via-submodule"
architectural rule, the build harness now lives in eliza and is consumed
either as a workspace symlink (`MILADY_ELIZA_SOURCE=local`) or as the
published npm package (`MILADY_ELIZA_SOURCE=packages`).

## Pins

See `VERSIONS`. Each line is `<dep>=<ref>` where `<ref>` is anything
`git fetch` accepts (tag, branch name, or commit SHA). For llama.cpp,
the default points at the `elizaOS/llama.cpp` fork's `main` branch tip;
the `LLAMA_CPP_REPO` env var can override to upstream
`ggml-org/llama.cpp` for an A/B parity check.

## Build

```bash
# From the package dir:
bun run build:llama-cpp                 # both slices + xcframework
bun run build:llama-cpp:device          # device slice only
bun run build:llama-cpp:simulator       # simulator slice only
bun run clean:llama-cpp                 # nuke dist/ + build/

# Override source repo (parity check, fork-regression bisect, etc.):
LLAMA_CPP_REPO=https://github.com/ggml-org/llama.cpp \
  bun run build:llama-cpp

# Override iOS deployment target (default 15.0):
MILADY_IOS_MIN_VERSION=16.4 \
  bun run build:llama-cpp

# From a consumer package (workspace or installed):
bun run --filter @elizaos/ios-native-deps build:llama-cpp
```

The llama.cpp build produces:

```
llama.cpp/dist/
├── ios-arm64/                       device slice
│   ├── libllama.a                   ~80 MB; combined llama + ggml + common + shim
│   └── Headers/{llama.h, ggml.h, LlamaShim.h}
├── ios-arm64-simulator/             Apple-Silicon Mac simulator slice
│   └── (same layout)
└── LlamaCpp.xcframework/            ← consumed by Swift Pods (vendored_frameworks)
```

See `llama.cpp/README.md` for the full xcframework story including the
Swift shim contract (`shim/LlamaShim.h`), the flag-by-flag CMake surface,
and the verification recipes (`nm -gU`, `otool -l`).

## Consumers

| Consumer | Path | What it pulls |
|---|---|---|
| `@elizaos/capacitor-bun-runtime` | `eliza/packages/native-plugins/bun-runtime/` | `LlamaCpp.xcframework` via the Pod's `vendored_frameworks` |
| `@elizaos/bun-ios-runtime` | `eliza/packages/bun-ios-runtime/` | Pending wire-up (see M02-deps-cross-build) |
| `milady` iOS app shell | `milady/native/ios-bun-port/` | Pending wire-up (the directory is being migrated to depend on this package) |

## Prerequisites

- macOS host with full Xcode (Command Line Tools alone won't ship the
  iOS SDK or `xcrun --sdk iphoneos`).
- `cmake >= 3.21` (`brew install cmake`).
- Disk: ~3 GB during build, ~250 MB after `clean`.
- Time: ~5–8 min on M3, ~12 min on M1.
