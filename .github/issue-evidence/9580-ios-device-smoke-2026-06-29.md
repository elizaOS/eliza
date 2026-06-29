# Issue 9580 - Physical iPhone smoke

Date: 2026-06-29
Device: physical iPhone 15 Pro (iPhone16,1), iOS 26.5
Host toolchain: Xcode 26.4.1

## Commands

```bash
node packages/app-core/scripts/ios-xcframework/build-xcframework.mjs \
  --output /tmp/LlamaCpp-9580-2026-06-29.xcframework \
  --verify

ELIZA_IOS_DEVELOPMENT_TEAM=<redacted> \
node packages/app-core/scripts/ios-xcframework/run-physical-device-smoke.mjs \
  --xcframework /tmp/LlamaCpp-9580-2026-06-29.xcframework \
  --benchmark-model <local-model-root>/eliza-1-0_8b.bundle/text/eliza-1-0_8b-128k.gguf \
  --report .github/issue-evidence/9580-ios-device-smoke-2026-06-29.json \
  --xcodebuild-arg -allowProvisioningUpdates \
  --collect-test-diagnostics never \
  --keep-temp
```

## Result

PASS.

- XCFramework build verified device and simulator slices: `ios/arm64`, `ios-simulator/arm64`.
- Kernel and runtime symbol audits passed for both slices.
- Physical iPhone test run passed 4 XCTest cases with 0 failures.
- The test app resolved the required llama, kernel, and voice ABI symbols.
- `MTLCreateSystemDefaultDevice()` returned `Apple A17 Pro GPU` on the physical iPhone.
- Optional text-generation benchmark loaded the real `eliza-1-0_8b-128k.gguf` model and produced CPU and Metal benchmark samples.

## Text Benchmark Snapshot

| mode | prompt t/s | predicted t/s | evaluated | predicted | memory before | memory after | memory delta | thermal |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| cpu | 108.270914 | 51.502146 | 11 | 15 | 23.84 MiB | 79.53 MiB | +55.69 MiB | nominal -> nominal |
| metal | 22.513994 | 36.997117 | 11 | 15 | 79.53 MiB | 72.13 MiB | -7.41 MiB | nominal -> nominal |

## Artifacts

- Physical-device JSON report: `9580-ios-device-smoke-2026-06-29.json`
- XCFramework verification log: `9580-ios-xcframework-verify-2026-06-29.log`

## Scope Note

This is a runtime, Metal, symbol, and weight-backed text smoke on physical iOS hardware. It does not claim a full app-shell walkthrough, audio capture, or first-audio voice benchmark.
