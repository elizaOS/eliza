# iOS LlamaCpp.xcframework — runbook

This directory contains the iOS xcframework packager that the mobile
build pipeline uses to glue per-target static archives produced by
`packages/app-core/scripts/build-llama-cpp-dflash.mjs` into a
well-formed `LlamaCpp.xcframework` consumed by the patched
`llama-cpp-capacitor@0.1.5` Cocoapod.

## Why this exists (Wave-4-F)

Pre-Wave-4-F, `run-mobile-build.mjs` built `LlamaCpp.xcframework` by
shelling out to `cmake` against the **upstream npm package's bundled
`ios/` source tree**. That source has none of the eliza kernels —
TurboQuant, QJL, PolarQuant, DFlash — so every iOS Capacitor build
silently shipped a stock llama.cpp framework, in violation of
[`packages/inference/AGENTS.md`](../../../inference/AGENTS.md) §3
("Required for ALL tiers — TurboQuant / QJL / PolarQuant / DFlash;
runtime MUST refuse to load a bundle missing any required kernel").

`packages/inference/DEVICE_SUPPORT_GAP_2026-05-10.md` row 4 / 5 / blocker
#1 / blocker #5 documented this disconnect: the
`build-llama-cpp-dflash.mjs --target ios-arm64-{metal,simulator-metal}`
build paths existed and produced eliza-kernel-bearing archives, but
nothing consumed those archives — they were orphaned.

Wave-4-F rewires `run-mobile-build.mjs` to delegate to the dflash
builder and pipes the produced archives through `build-xcframework.mjs`.

## Pipeline

```
build-llama-cpp-dflash.mjs --target ios-arm64-metal
  ├─ checkout elizaOS/llama.cpp @ v0.4.0-eliza (TBQ + QJL + Polar +
  │  DFlash + W4-B kernels onto upstream b8198)
  ├─ apply Metal kernel patches (kernel-patches/metal-kernels.mjs;
  │  EMBED-path is currently a documented gap — see "Known gaps" below)
  ├─ cmake -DCMAKE_SYSTEM_NAME=iOS -DCMAKE_OSX_SYSROOT=iphoneos
  │       -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON …
  ├─ build llama / ggml / ggml-base / ggml-cpu / ggml-metal static .a
  └─ install -> $ELIZA_STATE_DIR/local-inference/bin/dflash/ios-arm64-metal/
       libllama.a, libggml*.a, include/, CAPABILITIES.json
       (build hard-fails via writeCapabilities() on missing kernels)

build-llama-cpp-dflash.mjs --target ios-arm64-simulator-metal
  └─ same as above but with -DCMAKE_OSX_SYSROOT=iphonesimulator;
     installs to .../bin/dflash/ios-arm64-simulator-metal/

ios-xcframework/build-xcframework.mjs
  ├─ load both slices, refuse to proceed if either is missing
  ├─ libtool -static -o LlamaCpp <every .a in slice>     (one merged archive per slice)
  ├─ assemble static .framework per slice with Info.plist + module.modulemap
  ├─ xcodebuild -create-xcframework -framework <device> -framework <sim> -output …
  └─ optional --verify: nm-grep AGENTS.md §3 kernel symbols in both slices,
     parse the produced Info.plist for slice metadata. Hard-fail on any miss.

run-mobile-build.mjs ensureIosLlamaCppVendoredFramework()
  ├─ guard: skip if ELIZA_IOS_INCLUDE_LLAMA / ELIZA_IOS_INCLUDE_LLAMA is unset
  ├─ ensureDflashIosTarget("ios-arm64-metal")
  ├─ ensureDflashIosTarget("ios-arm64-simulator-metal")
  ├─ build-xcframework.mjs --output node_modules/llama-cpp-capacitor/ios/
  │                                  Frameworks-xcframework/LlamaCpp.xcframework
  │                        --verify
  ├─ patchLlamaCppCapacitorPodspecForXcframework() (existing, unchanged)
  └─ archive npm-bundled stock LlamaCpp.framework / llama-cpp.framework out
     of FRAMEWORK_SEARCH_PATHS so the linker resolves the eliza xcframework

xcodebuild -workspace App/App.xcworkspace … (CocoaPods picks up the
patched podspec, links against the eliza xcframework)
```

## How to build the xcframework manually

Prerequisites: macOS host with Xcode installed, `cmake` on PATH, network
access to `github.com/elizaOS/llama.cpp` (first run clones the fork).

```sh
# Build both per-platform slices (~3–5 min each on M-series Mac).
node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target ios-arm64-metal
node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target ios-arm64-simulator-metal

# Assemble the xcframework with full kernel verification.
node packages/app-core/scripts/ios-xcframework/build-xcframework.mjs \
  --output /tmp/LlamaCpp.xcframework \
  --verify

# One-shot: build slices if missing, then package + verify.
node packages/app-core/scripts/ios-xcframework/build-xcframework.mjs \
  --output /tmp/LlamaCpp.xcframework \
  --build-if-missing \
  --verify
```

`build-xcframework.mjs --verify` runs **three** independent checks:

1. **AGENTS.md §3 kernel-symbol audit** — `nm -g` over every `.a` in
   each slice, asserting the QJL, PolarQuant, DFlash, Turbo3, Turbo4
   symbol patterns are present. Missing symbols hard-fail with a
   diagnostic that names the missing kernel + slice + expected archive.
2. **Runtime-symbol audit** — the slice must also export the Capacitor
   bridge symbols (`llama_init_context`, `llama_completion`, etc.) and
   the `eliza_inference_*` voice ABI v1 symbols. Today those ABI symbols
   come from `runtime-symbol-shim.c`: a fail-closed static archive that
   links and reports structured "not loaded / unsupported" errors until
   real mobile context and OmniVoice weight loading are wired.
3. **xcframework structural audit** — parses the produced `Info.plist`'s
   `AvailableLibraries` array via `plutil`. Empty or malformed = error.

## How to verify Eliza-1 kernels are in the produced binary

After the xcframework is written, manual verification:

```sh
# Inspect the merged static archive in each slice.
nm -g /tmp/LlamaCpp.xcframework/ios-arm64/LlamaCpp.framework/LlamaCpp \
  | grep -iE "qjl|polar|dflash|turbo"
nm -g /tmp/LlamaCpp.xcframework/ios-arm64-simulator/LlamaCpp.framework/LlamaCpp \
  | grep -iE "qjl|polar|dflash|turbo"

# Inspect the xcframework's Info.plist (should list both slices).
plutil -p /tmp/LlamaCpp.xcframework/Info.plist
```

Expected QJL/PolarQuant/DFlash symbols in both slices today:

```
T _dequantize_row_qjl1_256
T _quantize_qjl1_256
T _ggml_compute_forward_attn_score_qjl
T _ggml_attn_score_qjl
T _ggml_fused_attn_qjl_tbq
T _dequantize_row_q4_polar
T _quantize_q4_polar
T _llama_decode               # DFlash CLI / runtime entry surface
```

## How to swap it into the Capacitor app

The Capacitor app picks up the xcframework automatically via
`ensureIosLlamaCppVendoredFramework()` whenever:

- `ELIZA_IOS_INCLUDE_LLAMA=1` (or `ELIZA_IOS_INCLUDE_LLAMA=1`) is set
  in the environment, AND
- `node packages/app-core/scripts/run-mobile-build.mjs ios` (or
  `ios-overlay`) is invoked on a macOS host.

The wiring is end-to-end:

1. Both dflash slices build (or are reused if `CAPABILITIES.json`
   exists). Either build hard-failing aborts the iOS build.
2. `build-xcframework.mjs --verify` assembles the bundle and refuses
   to write it if kernel symbols are missing.
3. `patchLlamaCppCapacitorPodspecForXcframework()` rewrites the npm
   package's podspec to point at
   `ios/Frameworks-xcframework/LlamaCpp.xcframework`. Note: this also
   relies on `packages/app-core/patches/llama-cpp-capacitor@0.1.5.patch`
   already swapping the SPM-side framework reference; the patch's
   `LlamaCpp.podspec` / `LlamaCppCapacitor.podspec` edits are kept in
   sync with the runtime patcher.
4. The npm-shipped stock `LlamaCpp.framework` / `llama-cpp.framework`
   is moved out of `node_modules/llama-cpp-capacitor/ios/Frameworks/`
   into a `.{name}-stock-archive/` sibling so CocoaPods'
   `FRAMEWORK_SEARCH_PATHS` cannot resolve `-framework LlamaCpp` to the
   wrong (stock, kernel-less) framework.
5. `pod install` + `xcodebuild` link against the eliza xcframework.

To re-run from scratch (after a eliza-llama.cpp fork bump or kernel
patch update):

```sh
rm -rf "$ELIZA_STATE_DIR/local-inference/bin/dflash/ios-arm64-metal" \
       "$ELIZA_STATE_DIR/local-inference/bin/dflash/ios-arm64-simulator-metal" \
       node_modules/llama-cpp-capacitor/ios/Frameworks-xcframework/LlamaCpp.xcframework

ELIZA_IOS_INCLUDE_LLAMA=1 \
  node packages/app-core/scripts/run-mobile-build.mjs ios
```

## Known gaps

### iOS runtime bridge is symbol-ready, not generation-ready

The iOS slices now embed the same shipped Metal kernel payload as desktop
Metal and `build-xcframework.mjs --verify` passes the kernel-symbol and
runtime-symbol audits. The added `libeliza-ios-runtime-shim.a` is a link
and smoke-test bridge, not a complete mobile inference engine. It refuses
real text/voice generation until the mobile bridge is wired to a live llama
context and real OmniVoice GGUF assets.

### Real iPhone hardware verification

`metal_verify` in `packages/inference/verify/` runs on macOS via
`MTLDevice.newLibraryWithSource`, not on iOS. The physical-device smoke
entrypoint is now:

```sh
ELIZA_IOS_DEVELOPMENT_TEAM=<Apple Team ID> \
  node packages/app-core/scripts/ios-xcframework/run-physical-device-smoke.mjs \
    --build-if-missing \
    --report packages/inference/reports/porting/2026-05-11/ios_device_smoke.json
```

The smoke refuses simulators. It creates a temporary hosted XCTest
project, links the same `LlamaCpp.xcframework` slot consumed by
`llama-cpp-capacitor`, runs on a connected physical iPhone/iPad, and
checks:

1. `MTLCreateSystemDefaultDevice()` returns a real Metal device.
2. The LlamaCpp bridge symbols resolve from the linked framework.
3. QJL, PolarQuant, and DFlash runtime symbols resolve.
4. The `libelizainference` voice ABI v1 symbols resolve. Use
   `--skip-voice-abi` only for diagnosis; a release smoke must not skip it.

If no physical device is attached, unlocked, trusted, and in Developer
Mode, the script exits non-zero and prints the offline device list
reported by `xcrun xctrace list devices`.

This still does **not** claim text/voice numerical generation because no
Eliza-1 weights are bundled into the XCTest package. The next gate after
this smoke passes is a real bundle smoke that downloads or stages final
Eliza-1 artifacts, loads the selected tier, and measures first-token /
first-audio latency plus peak RSS.

### Why no fallback to the npm-bundled framework

Per AGENTS.md §3:

> "If a required kernel fails to load, fails verification, or is
> missing from the build … the engine MUST refuse to activate the
> bundle and surface a structured error to the UI. It MUST NOT
> silently fall back to unoptimized inference."

The build pipeline mirrors that runtime contract: a failed dflash
build, a missing kernel symbol, or a malformed xcframework throws
through the iOS build. There is no escape hatch that points the
Capacitor pod back at the stock npm framework.
