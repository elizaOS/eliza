# Android baseline profile capture and apply

Baseline profiles give Android apps a 20-40% faster cold start and 15-25%
faster initial frame in production as of 2026. Since Android 14, dexopt is
handled by ART Service per-architecture; the RISC-V backend uses the same
mechanism.

## Capture flow (per app)

```
gradle :app:generateBaselineProfile
  -> Macrobenchmark runs a representative cold-start scenario.
  -> Profileinstaller writes baseline-prof.txt.
  -> Apk ships baseline-prof.txt under assets/dexopt/baseline.prof.
```

`compiler/baseline-profiles/capture.sh` wraps the Macrobenchmark
invocation against the Cuttlefish RISC-V image (BLOCKED on AOSP RISC-V
branch SHA pin per [`android-rva23-prebuilts.md`](../../docs/toolchain/android-rva23-prebuilts.md)).

## Apply flow

ART Service consumes the `baseline.prof` shipped in the apk. The
`bg-dexopt-job` JobScheduler entry rewrites the on-device profile after
first run.

## Status

- Recipe documented.
- End-to-end capture BLOCKED on AOSP RISC-V Cuttlefish image plus
  `androidx.benchmark` library RISC-V support.

## Evidence gate

[`docs/evidence/compiler/baseline-profile-evidence.yaml`](../../docs/evidence/compiler/baseline-profile-evidence.yaml).
