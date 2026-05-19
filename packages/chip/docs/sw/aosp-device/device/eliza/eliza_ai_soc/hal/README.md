# Eliza AOSP HAL plan

This directory contains a host-buildable runtime skeleton for the future
`e1_npu.default` integration. Do not add `e1_npu.default`,
`hwcomposer.eliza_ai_soc`, or active VINTF HAL entries to the product until
an external AOSP tree has buildable source or reviewed prebuilts and archived
evidence logs.

Local fail-closed proof:

```sh
scripts/android/capture_e1_npu_hal_absent_device.sh
```

Equivalent manual command:

```sh
c++ -std=c++17 -Wall -Wextra -Werror \
  sw/aosp-device/device/eliza/eliza_ai_soc/hal/e1_npu_runtime.cc \
  sw/aosp-device/device/eliza/eliza_ai_soc/hal/e1_npu_probe_main.cc \
  -I sw/aosp-device/device/eliza/eliza_ai_soc/hal \
  -o /tmp/e1_npu_probe
/tmp/e1_npu_probe --device /tmp/definitely-missing-e1-npu
```

Required absent-device output includes:

```text
e1_npu_status=unsupported
device_node_present=false
runtime_supported=false
nnapi_acceleration=false
claim_boundary=no_nnapi_acceleration_without_android_nnapi_hal_and_device_evidence
```

`scripts/android/capture_e1_npu_hal_absent_device.sh` writes the transcript
to `docs/evidence/android/e1-npu/absent-device-probe.log`.
`python3 sw/check_bsp_scaffolds.py aosp` still verifies the scaffold terms.
Both are local checker evidence only; they are not device evidence and they do
not prove Android NNAPI acceleration.

Required fail-closed behavior:

- `e1_npu.default`: open `/dev/e1-npu`; if absent, report unsupported and
  do not claim accelerator availability. When present, require a character
  device before any fixed-vector smoke path can run. The host runtime skeleton
  keeps `nnapi_acceleration=false` in all local-checker paths.
- `hwcomposer.eliza_ai_soc`: bind only to a proven framebuffer or DRM node.
  If no display node exists, fail service startup or report unsupported
  composition; do not claim GLES, Vulkan, camera, input, audio, radio, GNSS, or
  NFC support.

Evidence required before enabling packages:

- External `vendorimage` log showing the HAL binaries are built into
  `vendor.img`.
- External `checkvintf` log showing newly declared VINTF entries are compatible.
- SELinux policy and neverallow build logs.
- Bounded Cuttlefish, QEMU, or Renode smoke transcript that keeps Android boot
  claims separate from virtual-device smoke evidence.
- Filled Android proof manifest derived from
  `docs/benchmarks/capabilities/e1_npu_android_proof_manifest.template.json`
  with blocked statuses replaced only by real external AOSP results and
  SHA-256 values for VTS, CTS, VINTF, SELinux, NNAPI query, and absent-device
  probe artifacts.
# HAL Evidence Boundary

HAL source or prebuilts are not checked in. `e1_npu.default` and
`hwcomposer.eliza_ai_soc` remain blocked until external AOSP evidence exists.
