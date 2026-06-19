# CTS / VTS Smoke Plan (Cuttlefish riscv64)

This plan picks the subset of CTS and VTS modules that can run against the
pre-silicon Cuttlefish riscv64 virtual device. It excludes anything that
requires camera, cellular, audio, Vulkan, GLES conformance, biometrics, secure
element, Widevine L1, Play services, or GMS — none of those exist on this
target.

A passing run of this subset is **not** Android CDD compatibility. It is the
smallest set that proves userspace, kernel, binder, VINTF, and SELinux
plumbing is alive end-to-end on riscv64.

## Prerequisites

- `docs/android/cuttlefish-riscv64-bringup.md` is green (shell-first boot
  succeeds and boot-marker checklist is recorded).
- The AOSP tree at `${AOSP_TREE}` has built `cts` and `vts` host harnesses:
  ```sh
  source build/envsetup.sh
  lunch aosp_cf_riscv64_phone-trunk_staging-userdebug
  m -j"$(nproc)" cts vts
  ```
- `cts-tradefed` / `vts-tradefed` exist:
  - `${AOSP_TREE}/out/host/linux-x86/cts/android-cts/tools/cts-tradefed`
  - `${AOSP_TREE}/out/host/linux-x86/vts/android-vts/tools/vts-tradefed`
- `adb devices` lists exactly one ready device.
- Archive root: `out/cf-riscv64/cts-vts/<UTC timestamp>/`.

## Module Selection Rules

Include a module only if all are true:
1. It exercises kernel, libc, binder, VINTF, SELinux, or framework plumbing.
2. It does not require camera, cellular, audio HAL, Vulkan, GLES, biometrics,
   secure element, NFC, GPS, Play services, Widevine, or GMS.
3. It does not depend on activity-manager features the cf-riscv64 image lacks.

## CTS Smoke Modules

| Module | Prereq | Why safe on cf-riscv64 | Pass criterion |
|---|---|---|---|
| `CtsLibcoreTestCases` | boot complete, adb | CPU + libc + ART | 100% pass or triaged |
| `CtsLibcoreOjTestCases` | boot complete, adb | OpenJDK OJ subset | 100% pass or triaged |
| `CtsBionicTestCases` | boot complete, adb | Bionic libc/linker on riscv64 | 100% pass or triaged |
| `CtsJniTestCases` | boot complete, adb | JNI ABI on riscv64 | 100% pass or triaged |
| `CtsUtilTestCases` | boot complete, adb | `android.util` framework helpers | 100% pass or triaged |
| `CtsOsTestCases` (lite) | boot complete | Process/Looper/Handler | excluded: BatteryStats, network StrictMode flakes |
| `CtsAppOpsTestCases` | boot complete | AppOps framework | 100% pass or triaged |
| `CtsPermissionTestCases` | boot complete | Runtime permission framework | 100% pass or triaged |
| `CtsContentTestCases` (lite) | boot complete | ContentResolver / providers | excluded: SyncAdapter, Clipboard UI |
| `CtsSelinuxTargetSdkCurrentTestCases` | boot complete | SELinux target-SDK policy paths | 100% pass or triaged |
| `CtsSecurityTestCases` (subset) | boot complete | SELinux policy, file modes, ASLR | filters: `SELinuxTest`, `FileSystemPermissionTest` only |
| `CtsNetTestCases` (lite) | virtual NIC up | Socket/URI/DNS basics | filters: `SocketTest`, `UriTest` |

### CTS command

```sh
export ARCHIVE=out/cf-riscv64/cts-vts/$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$ARCHIVE"

cts-tradefed run commandAndExit cts \
  --abi riscv64 \
  --module CtsLibcoreTestCases \
  --module CtsBionicTestCases \
  --module CtsJniTestCases \
  --module CtsUtilTestCases \
  --module CtsAppOpsTestCases \
  --module CtsPermissionTestCases \
  --module CtsSelinuxTargetSdkCurrentTestCases \
  --module CtsSecurityTestCases \
    --include-filter "CtsSecurityTestCases android.security.cts.SELinuxTest" \
    --include-filter "CtsSecurityTestCases android.security.cts.FileSystemPermissionTest" \
  --module CtsNetTestCases \
    --include-filter "CtsNetTestCases android.net.cts.SocketTest" \
    --include-filter "CtsNetTestCases android.net.cts.UriTest" \
  --log-level-display info --skip-preconditions \
  | tee "$ARCHIVE/cts-stdout.log"

cp -r "$(ls -td out/host/linux-x86/cts/android-cts/results/* | head -1)" \
  "$ARCHIVE/cts-results/"
```

### CTS pass criteria

- Tradefed reports `PASSED` for every included test, OR every `FAILED` is
  classified in `$ARCHIVE/cts-triage.md` as
  `expected-exclusion | product-bug | infra-bug | unknown`.
- No SELinux denial in `adb logcat` is silently waived.
- `test_result.xml` + `device-info-files/` archived under `$ARCHIVE/cts-results/`.

## VTS Smoke Modules

| Module | Prereq | Why safe | Pass criterion |
|---|---|---|---|
| `VtsKernelConfigTest` | boot complete | Static kernel check | zero MISSING in `requiredConfigs` |
| `VtsKernelProcFileApiTest` | boot complete | `/proc` ABI surface | 100% pass |
| `VtsTrebleVintfTest` | boot complete | Vendor + framework manifests compatible | every declared HAL matched |
| `VtsBinderTest` | boot complete | Binder driver alive | 100% pass |
| `VtsHalManagerTest` | boot complete | `hwservicemanager` healthy | every advertised service reachable |
| `VtsSecuritySELinuxPolicyHostTest` | AOSP host | sepolicy parses + matches | host-side parse OK |
| `VtsHalTest` (declared HALs only) | boot complete | HALs in vendor manifest answer interface descriptors | limit to whatever `vendor.img` declares |

Skip explicitly:
- `VtsHalGraphicsComposer*` (no composer claim on cf-riscv64 path here)
- `VtsHalCamera*`, `VtsHalAudio*`, `VtsHalNeuralnetworks*`
- `VtsHalBiometrics*`, `VtsHalKeymintStrongbox*`
- `VtsHalRadio*`, `VtsHalCellBroadcast*`, `VtsHalSim*`

### VTS command

```sh
vts-tradefed run commandAndExit vts \
  --module VtsKernelConfigTest \
  --module VtsKernelProcFileApiTest \
  --module VtsTrebleVintfTest \
  --module VtsBinderTest \
  --module VtsHalManagerTest \
  --module VtsSecuritySELinuxPolicyHostTest \
  --log-level-display info --skip-preconditions \
  | tee "$ARCHIVE/vts-stdout.log"

cp -r "$(ls -td out/host/linux-x86/vts/android-vts/results/* | head -1)" \
  "$ARCHIVE/vts-results/"
```

## Archive Layout

```
out/cf-riscv64/cts-vts/<UTC>/
  build-info.txt          # AOSP BUILD_ID, manifest sha256, host info
  device-info.txt         # adb getprop dump
  cts-stdout.log
  cts-result.json         # copied/overridable path defaults to docs/evidence/android/e1-npu/cts-result.json
  cts-results/            # tradefed xml + html + device-info
  cts-triage.md
  vts-stdout.log
  vts-result.json         # copied/overridable path defaults to docs/evidence/android/e1-npu/vts-result.json
  vts-results/
  vts-triage.md
```

## Wrappers

`scripts/android/run_cts_smoke.sh` and `scripts/android/run_vts_smoke.sh` are
the canonical entry points. They fail closed when `AOSP_TREE` is missing,
tradefed is missing, or `adb` does not see exactly one ready device.
On completion they also write manifest-ready JSON summaries to
`docs/evidence/android/e1-npu/cts-result.json` and
`docs/evidence/android/e1-npu/vts-result.json` by default. Those files only
carry `RESULT=0` when Tradefed exits successfully; the Android e1-NPU proof
manifest checker remains blocked otherwise. By default the wrappers refresh
`docs/evidence/android/e1-npu/android-proof-manifest.json` after writing their
result JSON; set `E1_NPU_REFRESH_ANDROID_MANIFEST=0` to skip that refresh.

## References

- CTS: https://source.android.com/docs/compatibility/cts
- VTS: https://source.android.com/docs/core/tests/vts
- Treble VINTF: https://source.android.com/docs/core/architecture/vintf
