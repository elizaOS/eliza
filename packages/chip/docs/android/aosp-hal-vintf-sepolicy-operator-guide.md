# AOSP HAL + VINTF + SELinux + CVD HAL-smoke operator guide

End-to-end recipe to take the AOSP build tree produced by
[Cuttlefish riscv64 AOSP build pipeline](cuttlefish-riscv64-bringup.md)
(Task 28) and capture the four HAL evidence logs that close Task 31:

| Log | Marker added |
|---|---|
| `docs/evidence/android/eliza_ai_soc_checkvintf.log` | `VINTF_COMPAT=ok` |
| `docs/evidence/android/eliza_ai_soc_sepolicy_build.log` | `SEPOLICY_BUILD=ok` |
| `docs/evidence/android/eliza_ai_soc_selinux_neverallow.log` | `SEPOLICY_NEVERALLOW=ok` |
| `docs/evidence/android/eliza_ai_soc_cvd_hal_smoke.log` | `HAL_REGISTERED=true`, `INTERFACE_AVAILABLE=true` |

All commands run from the chip-package working directory
(`packages/chip`). Replace `/path/to/aosp` with the AOSP workspace
produced by `sw/aosp-device/build-aosp-riscv64.sh`.

## Prerequisites

1. AOSP workspace built with `aosp_cf_riscv64_phone-trunk_staging-userdebug`
   (the Cuttlefish phone product) **with** the
   `device/eliza/cuttlefish_e1` overlay inherited so the simulator HAL
   binary is staged into `vendor.img`.

   Wire-up (one-time, in the AOSP workspace after Task 28 imports
   `device/eliza/`):

   ```sh
   # Append the Cuttlefish overlay to the lunched phone product.
   # Pick ONE of the following techniques:

   # (a) device/google/cuttlefish/vsoc_riscv64/aosp_cf.mk style:
   echo '$(call inherit-product, device/eliza/cuttlefish_e1/eliza_e1_cuttlefish.mk)' \
       >> device/google/cuttlefish/vsoc_riscv64/aosp_cf.mk

   # (b) Or use a local_manifests overlay and a vendor manifest snippet
   # that inherits the same .mk from a vendor product layer.
   ```

   The overlay defines no new lunch target; it only adds
   `vendor.eliza.e1_npu@1.0-service.sim` to `PRODUCT_PACKAGES` and
   merges the SELinux file_contexts so the simulator HAL binary inherits
   the existing `hal_e1_npu_default` domain.

2. Host Cuttlefish stack installed (`launch_cvd` or `cvd`) and `adb` on
   `PATH`. The AOSP build's host artifacts under
   `out/host/linux-x86/{bin,cvd}` work directly.

3. `out/host/linux-x86/bin/checkvintf` is present. `m checkvintf` will
   build it if absent.

## 1. VINTF compat (`checkvintf --check-compat`)

```sh
AOSP_PRODUCT=eliza_ai_soc-trunk_staging-userdebug \
    sw/aosp-device/capture-aosp-evidence.sh /path/to/aosp checkvintf
```

The capture wrapper:

- runs `checkvintf --check-one --dirmap /vendor:.../vendor` to validate
  the device manifest in isolation;
- then runs `checkvintf --check-compat --dirmap /system:.../system
  --dirmap /vendor:.../vendor` to match the device manifest against the
  framework matrix;
- emits `VINTF_COMPAT=ok` only when both invocations exit 0.

Result: `docs/evidence/android/eliza_ai_soc_checkvintf.log` with
`eliza-evidence: status=PASS`, `RESULT=0`, and `VINTF_COMPAT=ok`.

## 2. Vendor SELinux policy build (`m vendor_sepolicy.cil selinux_policy sepolicy_neverallows`)

```sh
AOSP_PRODUCT=eliza_ai_soc-trunk_staging-userdebug \
    sw/aosp-device/capture-aosp-evidence.sh /path/to/aosp sepolicy-build
```

The capture wrapper:

- runs `m vendor_sepolicy.cil selinux_policy sepolicy_neverallows`;
- greps the compiled `vendor_sepolicy.cil` for `hal_e1_npu_default` and
  `e1_npu_device` so the transcript proves the HAL types compiled;
- emits `SEPOLICY_BUILD=ok` on `RESULT=0`.

Result: `docs/evidence/android/eliza_ai_soc_sepolicy_build.log` with
`eliza-evidence: status=PASS`, `RESULT=0`, and `SEPOLICY_BUILD=ok`.

## 3. SELinux neverallow (`m sepolicy_neverallows`)

```sh
AOSP_PRODUCT=eliza_ai_soc-trunk_staging-userdebug \
    sw/aosp-device/capture-aosp-evidence.sh /path/to/aosp selinux-neverallow
```

The capture wrapper:

- runs `m sepolicy_neverallows` so the build refuses to complete if any
  neverallow rule fires against the e1_npu types;
- greps the policy intermediates for `e1_npu` to record the surface
  under audit;
- emits `SEPOLICY_NEVERALLOW=ok` on `RESULT=0`.

Result: `docs/evidence/android/eliza_ai_soc_selinux_neverallow.log` with
`eliza-evidence: status=PASS`, `RESULT=0`, and `SEPOLICY_NEVERALLOW=ok`.

## 4. CVD HAL registration smoke (lshal)

```sh
AOSP_PRODUCT=aosp_cf_riscv64_phone-trunk_staging-userdebug \
    sw/aosp-device/check-cvd-hal-smoke.sh /path/to/aosp
```

(or equivalently via the dispatcher:)

```sh
sw/aosp-device/capture-aosp-evidence.sh /path/to/aosp cvd-hal-smoke
```

The smoke driver:

- sources `build/envsetup.sh` and lunches the Cuttlefish phone product;
- starts a Cuttlefish instance (`launch_cvd` or `cvd start`) in daemon
  mode and traps cleanup;
- waits for `sys.boot_completed=1` via `adb`;
- runs `adb shell lshal -i` and asserts the line for
  `vendor.eliza.e1_npu@1.0::IE1Npu/default`;
- refuses to pass if `lshal` reports `[N/A]` for the interface or the
  HAL line is missing entirely.

Result: `docs/evidence/android/eliza_ai_soc_cvd_hal_smoke.log` with
`eliza-evidence: status=PASS`, `RESULT=0`, `HAL_REGISTERED=true`,
`INTERFACE_AVAILABLE=true`, and the literal service name on a
`HAL_LINE=` row.

## 5. Validate all four logs against the strict gate

```sh
python3 scripts/check_software_bsp.py aosp --require-evidence
```

This re-reads the four logs above plus the rest of the AOSP evidence
slate, applies `docs/android/bsp-log-evidence-manifest.json`, and
returns non-zero if any marker is missing or any forbidden string is
present.

The completion gate is checked separately:

```sh
python3 scripts/check_aosp_simulator_completion_gate.py
```

## What this is NOT

- Not an Android compatibility claim. `checkvintf --check-compat`
  proves the manifest matches the framework matrix; it does not prove
  CDD, CTS, or VTS compliance.
- Not a hardware-acceleration claim for the e1 NPU. The Cuttlefish
  build runs the **software-simulator** HAL
  (`vendor.eliza.e1_npu@1.0-service.sim`). lshal cannot distinguish
  sim from silicon by service name; the `.sim` binary suffix and the
  `ro.hardware.e1_npu.backend=simulator` vendor property are the
  provenance signals.
- Not a substitute for VTS. VTS-on-Cuttlefish for `vendor.eliza.e1_npu`
  is a separate gate driven by Task 31's CTS/VTS plan log.

## Build invocation summary (operator only — not run from this repo)

The build half of this work is owned by
`sw/aosp-device/build-aosp-riscv64.sh` (Task 28). The relevant Soong
targets for the HAL surface are:

- `vendor.eliza.e1_npu@1.0` (HIDL package, generated from
  `device/eliza/eliza_ai_soc/hal/e1_npu/IE1Npu.hal`)
- `vendor.eliza.e1_npu@1.0-service` (real HAL, on-silicon path)
- `vendor.eliza.e1_npu@1.0-service.sim` (simulator HAL, Cuttlefish path)
- `hwcomposer.eliza_ai_soc` (framebuffer HWC stub)
- `android.hardware.graphics.composer@2.4-service.eliza_ai_soc`

Each is declared in its own `Android.bp` under
`device/eliza/eliza_ai_soc/hal/`. They land in the vendor image when
the corresponding product (real `eliza_ai_soc` or the
`cuttlefish_e1` overlay onto `aosp_cf_riscv64_phone`) lists them in
`PRODUCT_PACKAGES`.
