# llama.cpp — iOS xcframework build

This directory cross-builds the milady-controlled
[elizaOS/llama.cpp](https://github.com/elizaOS/llama.cpp) fork into
`LlamaCpp.xcframework` for iOS (device + simulator slices) with Metal
acceleration baked in. The fork carries the elizaOS kernels (Q4_POLAR /
QJL1_256 / TBQ4_0 / TBQ3_0 GGML types + Metal/Vulkan/CUDA kernels) and
DFlash spec-decode on top of stock upstream — the iOS Metal slice picks
up the same kernel surface the desktop Metal build uses.

The output is consumed by `@elizaos/capacitor-bun-runtime`'s Swift
`LlamaBridgeImpl.swift` via direct C symbol bindings — no module map or Swift
package interface required.

## Why we build from source instead of using `llama-cpp-capacitor@0.1.5`

The npm package `llama-cpp-capacitor` ships a precompiled `llama-cpp.framework`
that is unfit for our use:

1. **Device-only slice.** The bundled framework binary contains only an
   `arm64-ios` slice (`platform 2`). Apple-Silicon simulator builds need a
   separate `arm64-iphonesimulator` slice. Without it, the app fails to link
   in the simulator.
2. **Stale Capacitor wrapper symbols.** The Swift plugin in that package calls
   `llama_init_context`, `llama_completion`, etc. — none of those symbols are
   actually exported by the shipped binary. The Capacitor plugin path is
   broken out of the box.
3. **No bundled Metal library resource.** Modern llama.cpp embeds Metal
   shaders into `default.metallib`. The npm package ships none, and Metal
   refuses to initialize at runtime.
4. **`lm_` symbol prefix fork.** The package is built from a fork that
   renames `ggml_*` → `lm_ggml_*` to avoid conflicts with React Native
   `llama.rn`. That's fine for them, but it complicates any future swap to
   stock upstream tooling.

Building from source costs ~5 minutes on a current Mac and gives us:

- Both device and simulator slices in a proper `xcframework`.
- Metal shaders embedded via `GGML_METAL_EMBED_LIBRARY=ON`.
- Pin-controlled upstream version (see `../VERSIONS`).
- The `LlamaShim.c` translation unit folded into `libllama.a` so Swift can
  set struct fields without mirroring llama.cpp's layouts.

## Pinned version

See `../VERSIONS` (`llama.cpp=<ref>`). The pin may be a tag, branch name,
or raw commit SHA — anything `git fetch` accepts. Bump by editing that
file and re-running `./build-ios.sh`.

To verify the ref exists on the fork:

```bash
git ls-remote https://github.com/elizaOS/llama.cpp | grep <ref>
```

Override the source repo for an A/B parity check (e.g. point at stock
upstream `ggml-org/llama.cpp` to bisect a fork-specific regression):

```bash
LLAMA_CPP_REPO=https://github.com/ggml-org/llama.cpp ./build-ios.sh
```

## Build

```bash
cd packages/ios-native-deps/llama.cpp
./build-ios.sh                  # builds both slices + LlamaCpp.xcframework
./build-ios.sh device           # device slice only
./build-ios.sh simulator        # simulator slice only
./build-ios.sh clean            # wipe dist/ and build/
```

### Outputs

```
dist/
├── ios-arm64/
│   ├── libllama.a             ~80 MB; combined llama + ggml + common + shim
│   └── Headers/
│       ├── llama.h
│       ├── ggml.h
│       └── LlamaShim.h
├── ios-arm64-simulator/
│   ├── libllama.a
│   └── Headers/
│       ├── llama.h
│       ├── ggml.h
│       └── LlamaShim.h
└── LlamaCpp.xcframework/      ← consumed by the Pod
```

### Build prerequisites

- macOS host with full Xcode installed (not just Command Line Tools).
- `cmake >= 3.21`. `brew install cmake`.
- Disk space: ~3 GB during build, ~250 MB after cleanup.
- Time: ~5–8 min on M3, ~12 min on M1.

### Build flags worth knowing

| Flag                            | Purpose                                              |
| ------------------------------- | ---------------------------------------------------- |
| `GGML_METAL=ON`                 | Metal backend (device slice).                        |
| `GGML_METAL_EMBED_LIBRARY=ON`   | Bake `default.metallib` into the static lib.         |
| `GGML_NATIVE=OFF`               | Don't probe host CPU; cross-compile cleanly.         |
| `GGML_ACCELERATE=ON`            | Use Apple's Accelerate.framework on the CPU path.    |
| `BUILD_SHARED_LIBS=OFF`         | Static library — folds into xcframework.             |
| `LLAMA_BUILD_EXAMPLES=OFF`      | Skip CLI/server/tests.                               |
| `MILADY_LLAMA_SIM_METAL=ON`     | (env, default OFF) Enable Metal on simulator slice.  |
| `MILADY_IOS_MIN_VERSION=15.0`   | (env) iOS deployment target.                         |

## Consuming the build

The `ElizaosCapacitorBunRuntime.podspec` references the produced xcframework
via `vendored_frameworks`. The Pod is added to the iOS project by
`run-mobile-build.mjs`'s generator. The Swift `LlamaBridgeImpl.swift`
in `eliza/packages/native-plugins/bun-runtime/ios/Sources/.../bridge/`
binds to the C symbols via `@_silgen_name` — no module map or umbrella
header needed.

## Shim

`shim/LlamaShim.c` is a tiny C file that exposes type-safe setters for the
few `llama_*_params` struct fields Swift needs to write. It's bundled into
`libllama.a` so the Pod ends up with one static library and no separate
build artifact to track. When upstream renames a field, update the shim
once; Swift keeps working unchanged.

## Verifying the build

```bash
# Confirm both slices are in the xcframework:
ls dist/LlamaCpp.xcframework/

# Confirm Metal symbols are present in the device slice:
nm -gU dist/ios-arm64/libllama.a 2>/dev/null | grep ggml_backend_metal_init

# Confirm Milady shim symbols:
nm -gU dist/ios-arm64/libllama.a 2>/dev/null | grep milady_llama

# Inspect platform metadata:
otool -l dist/ios-arm64/libllama.a 2>/dev/null | grep -A 3 LC_BUILD_VERSION
```

The first command should list two directories (`ios-arm64`,
`ios-arm64-simulator`). The second should list at least one symbol
(`_ggml_backend_metal_init`). The third should show the five
`_milady_llama_*` symbols our Swift bridge calls via `@_silgen_name`.

## Updating

1. Bump the ref in `../VERSIONS` (`llama.cpp=<new-sha-or-tag>`).
2. Delete `src/` (or let `build-ios.sh` re-clone after wiping).
3. `./build-ios.sh clean && ./build-ios.sh`.
4. Spot-check that the symbols `LlamaBridgeImpl.swift` calls are still
   present in `dist/ios-arm64/libllama.a` (use `nm -gU`). If the fork
   API changed (e.g. a sampler function renamed), update both the
   `@_silgen_name` declarations in `LlamaBridgeImpl.swift` and the shim.

## Troubleshooting

- **"missing command: cmake"** — install with `brew install cmake`.
- **"no .a files produced"** — typically caused by an Xcode SDK mismatch.
  Run `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`
  and try again.
- **"fetch/checkout failed"** — the pinned ref in `../VERSIONS` doesn't
  exist on the fork. Check
  `git ls-remote https://github.com/elizaOS/llama.cpp` and update the
  pin. If you actually want stock upstream for this build, set
  `LLAMA_CPP_REPO=https://github.com/ggml-org/llama.cpp` and use a tag
  like `b4404`.
- **xcframework lipo error** — usually means the slices have overlapping
  architectures. Clean (`./build-ios.sh clean`) and rebuild.
