# #9580 iOS Physical Text Benchmark Telemetry - 2026-06-25

## Summary

Physical-device iOS text-generation benchmark passed on an iPhone 16 Pro Max (iPhone17,2), iOS 18.7.8, using the weight-backed `eliza-1-0_8b-128k.gguf` model. The committed JSON report redacts device identifiers, serial, ECID, tunnel IP, local model path, and Apple team id.

## Command

```bash
ELIZA_IOS_DEVELOPMENT_TEAM=REDACTED_TEAM_ID \
  node packages/app-core/scripts/ios-xcframework/run-physical-device-smoke.mjs \
    --xcframework /tmp/LlamaCpp-9580-text.xcframework \
    --benchmark-model REDACTED_LOCAL_MODEL_PATH/eliza-1-0_8b-128k.gguf \
    --report .github/issue-evidence/9580-ios-device-benchmark-telemetry-2026-06-25.json \
    --xcodebuild-arg -allowProvisioningUpdates \
    --collect-test-diagnostics never \
    --keep-temp
```

## Result

- XCTest status: `passed`
- Tests: 4 executed, 0 failures
- xcodebuild status: `0`
- Failure category: `none`

## Benchmark Telemetry

| backend | prompt tok/s | generation tok/s | tokens eval/pred | memory before MiB | memory after MiB | memory delta MiB | thermal state |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| cpu | 111.610540 | 52.286853 | 11 / 15 | 20.42 | 101.36 | 80.94 | nominal -> nominal |
| metal | 864.032676 | 45.853330 | 11 / 15 | 101.36 | 112.84 | 11.48 | nominal -> nominal |

Notes:
- `memory_footprint_*` is sampled in the generated XCTest via `task_info(TASK_VM_INFO).phys_footprint` around each benchmark call.
- `thermal_state_*` is sampled from `ProcessInfo.processInfo.thermalState` around each benchmark call.
- This evidence covers physical iOS text generation throughput plus lightweight RSS/thermal telemetry; it does not claim first-audio latency or full Capacitor app-shell UX.
