# iOS Physical-Device Runtime Smoke - 2026-05-11

## Status

Harness added, on-device PASS not claimed.

The runnable entrypoint is:

```sh
ELIZA_IOS_DEVELOPMENT_TEAM=<Apple Team ID> \
  node packages/app-core/scripts/ios-xcframework/run-physical-device-smoke.mjs \
    --build-if-missing \
    --report packages/inference/reports/porting/2026-05-11/ios_device_smoke.json
```

The command is intentionally physical-device only. It rejects simulators
and exits non-zero when no connected, unlocked, trusted iPhone/iPad is
available.

## What The Smoke Verifies

- `MTLCreateSystemDefaultDevice()` returns a Metal device on physical iOS.
- The same `LlamaCpp.xcframework` consumed by `llama-cpp-capacitor` links
  into an XCTest runner.
- LlamaCpp bridge symbols resolve at runtime.
- QJL, PolarQuant, and DFlash runtime symbols resolve at runtime.
- `libelizainference` ABI v1 voice symbols resolve at runtime. The
  diagnostic `--skip-voice-abi` flag exists, but a release smoke must not
  use it.

## What It Does Not Claim

This is not a numerical model-generation pass. No Eliza-1 weights are
staged into the temporary XCTest package. A release-quality iOS PASS still
requires a follow-up bundle smoke that loads the exact release artifact and
records:

- first token latency,
- first audio latency,
- peak RSS,
- thermal state,
- a minimal text response,
- a minimal TTS/voice response,
- voice-off mode proving TTS/ASR regions remain unmapped.

## Current Local Observation

The local lab Mac reports a physical iPhone in the `Devices Offline`
section of `xcrun xctrace list devices`, so the new smoke correctly cannot
claim an on-device pass here. Connect, unlock, trust, and enable Developer
Mode on the device before rerunning.
