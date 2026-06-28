# iOS Physical Device Smoke - 2026-06-25

Issue: #9580

Device: MoonCycles, iPhone 16 Pro Max (iPhone17,2), physical iOS device, connected through CoreDevice

Xcode: 26.4.1 (17E202)

xcframework: `/tmp/LlamaCpp-9258.xcframework`

Report: `9580-ios-device-smoke-2026-06-25.json`

Command:

```bash
ELIZA_IOS_DEVELOPMENT_TEAM=25877RY2EH \
  node packages/app-core/scripts/ios-xcframework/run-physical-device-smoke.mjs \
  --xcframework /tmp/LlamaCpp-9258.xcframework \
  --report .github/issue-evidence/9580-ios-device-smoke-2026-06-25.json \
  --xcodebuild-arg -allowProvisioningUpdates \
  --collect-test-diagnostics never \
  --keep-temp
```

Result: PASS

- `testMetalDeviceIsAvailableOnPhysicalIos` passed.
- `testLlamaKernelAndVoiceSymbolsResolve` passed.
- `testLibElizaInferenceAbiV1CallsMatchHeader` passed.
- `testOptionalElizaTextGenerationBenchmark` skipped because no `--benchmark-model` was provided.

Scope note: this refreshes the physical-device runtime-symbol and voice-ABI gate only. It does not claim weight-backed Eliza-1 text generation, voice generation, first-token/audio latency, RSS, or thermal results.
