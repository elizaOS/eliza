# Issue 9580 iOS Device Text Benchmark

## Summary

- Status: pass
- Device: iPhone 16 Pro Max (iPhone17,2), physical iOS 18.7.8
- Destination: physical iOS device identifier redacted in the public report
- Xcode: 26.4.1 (17E202)
- Model: `/Users/shawwalters/.eliza/local-inference/models/eliza-1-0_8b.bundle/text/eliza-1-0_8b-128k.gguf`
- XCFramework: `/tmp/LlamaCpp-9580-text.xcframework`
- Raw report: `.github/issue-evidence/9580-ios-device-benchmark-2026-06-25.json`

## What This Proves

The iOS `LlamaCpp.xcframework` text ABI loads a real GGUF model on a physical
iPhone and completes the benchmark path in both CPU-only and Metal-backed modes.
The XCTest suite executed four tests with zero failures, including symbol
resolution, physical Metal availability, and optional text generation benchmark.

This slice does not claim the audio/RSS/thermal/app-shell rows from the broader
non-Android matrix.

## Commands

```bash
ELIZA_MTP_LLAMA_CPP_SRC=/Users/shawwalters/.eliza/local-inference/desktop-llama-build/src \
ELIZA_MTP_FORCE_REBUILD=1 \
node packages/app-core/scripts/build-llama-cpp-mtp.mjs --target ios-arm64-metal

ELIZA_MTP_LLAMA_CPP_SRC=/Users/shawwalters/.eliza/local-inference/desktop-llama-build/src \
ELIZA_MTP_FORCE_REBUILD=1 \
node packages/app-core/scripts/build-llama-cpp-mtp.mjs --target ios-arm64-simulator-metal

node packages/app-core/scripts/ios-xcframework/build-xcframework.mjs \
  --output /tmp/LlamaCpp-9580-text.xcframework \
  --verify

ELIZA_IOS_DEVELOPMENT_TEAM=<redacted-team-id> \
node packages/app-core/scripts/ios-xcframework/run-physical-device-smoke.mjs \
  --xcframework /tmp/LlamaCpp-9580-text.xcframework \
  --benchmark-model /Users/shawwalters/.eliza/local-inference/models/eliza-1-0_8b.bundle/text/eliza-1-0_8b-128k.gguf \
  --report .github/issue-evidence/9580-ios-device-benchmark-2026-06-25.json \
  --xcodebuild-arg -allowProvisioningUpdates \
  --collect-test-diagnostics never \
  --keep-temp
```

## Benchmark Results

| Mode | Prompt tok/s | Predicted tok/s | Tokens evaluated | Tokens predicted |
| --- | ---: | ---: | ---: | ---: |
| CPU | 73.159214 | 49.551886 | 11 | 15 |
| Metal | 36.904826 | 41.980471 | 11 | 15 |

## Embedded Metallib Headers

Device slice:

```text
Platform: IOS
PlatformMajor: 16
```

Simulator slice:

```text
Platform: IOS (SIMULATOR)
PlatformMajor: 16
```

## Result

`run-physical-device-smoke.mjs` wrote `status: "passed"` and captured both
`ELIZA_IOS_TPS_RESULT` rows in the JSON report.
