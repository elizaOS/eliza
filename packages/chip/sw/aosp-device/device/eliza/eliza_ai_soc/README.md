# eliza_ai_soc AOSP device tree (v0)

Backing contract: `sw/platform/e1_platform_contract.json`.

This directory is an Android device tree scaffold for an external AOSP
checkout. It is `host_checkable_manifest_only_not_boot_evidence` and
intentionally tagged `expected_future_log_markers_only_not_boot_evidence`.
It does not build Android, run Cuttlefish, or boot e1_soc on its own.

## Lunch + vendorimage flow (external AOSP tree)

```sh
# From the Eliza-AI-SoC checkout:
sw/aosp-device/import-aosp-device.sh /path/to/aosp

cd /path/to/aosp
source build/envsetup.sh
lunch eliza_ai_soc-trunk_staging-userdebug
m nothing            # sanity: product file is wired in
m vendorimage        # builds /vendor with the two stub HALs
```

Expected first-pass artifacts (capture as evidence under
`docs/evidence/android/`):

```
out/target/product/eliza_ai_soc/vendor.img
out/target/product/eliza_ai_soc/installed-files-vendor.txt
out/target/product/eliza_ai_soc/vendor/etc/vintf/manifest/eliza_e1.xml
```

`make aosp-bsp-check` and `python3 sw/aosp-device/scripts/check_aosp_bsp.py`
remain BLOCKED until those logs are checked in.

## What this v0 device actually claims

Only the fail-closed NPU VINTF fragment is installed in the current
vendorimage evidence path. The HAL source scaffolds remain present for
external-tree integration once the matching generated HIDL package is added.

| HAL package | Backing node | Behavior |
|---|---|---|
| `vendor.eliza.e1_npu@1.0-service` | `/dev/e1-npu` | Fail-closed. Returns `NOT_SUPPORTED` when the node is absent; otherwise the single `smoke()` RPC reads the driver identity word at `E1_NPU_RESULT_OFFSET` (`cuttlefish_riscv64`, `qemu_riscv64`, and `renode_e1_soc` paths all use the same kernel driver). |
| `android.hardware.graphics.composer@2.4-service.eliza_ai_soc` | `/dev/graphics/fb0` | Framebuffer pass-through. SurfaceFlinger runs in client composition. |

## Explicit non-claims (v0)

This device does NOT provide and MUST NOT advertise:

- Audio on the bare `eliza_ai_soc` vendorimage is intentionally omitted in v0:
  the on-silicon product has no packaged audio stack yet. Simulated microphone
  and speaker evidence is captured against the Cuttlefish phone product plus
  the `cuttlefish_e1` overlay, not this fail-closed hardware product.
- Camera (no camera HAL, no camera2 metadata, no CTS camera result).
- Cellular modem / telephony / RIL / IMS / eSIM.
- Bluetooth (no HCI transport, no bluedroid config, no LE).
- WiFi (no SDIO driver, no wpa_supplicant config, no hostapd, no regdb).
- GNSS, NFC, sensors, thermal, power, secure_element, IR.
- Vulkan (no `vulkan.*` HAL, no ICD, no SPIR-V claim).
- GLES2/3 hardware acceleration (no Mali/Adreno/etc., no GLES driver).
- NNAPI (`android.hardware.neuralnetworks` is not declared; the e1_npu
  HAL is a vendor extension and is NOT a NNAPI driver in v0).
- Keymaster / KeyMint / Gatekeeper / biometric / DRM / Widevine.
- A/B slots, AVB verified boot, dm-verity error correction, recovery,
  OTA, secure fastboot, unauthorized-flashing protection. `fstab.eliza`
  documents AVB as `FUTURE (not yet implemented)`.
- Google Play / GMS / Play Protect / Play Integrity certification. This
  device is AOSP-only and is not a Play-certified product.

## File map

| File | Purpose |
|---|---|
| `AndroidProducts.mk` | Exposes `eliza_ai_soc-trunk_staging-userdebug` to lunch. |
| `eliza_ai_soc.mk` | Inherits `core_64_bit_only.mk` + `aosp_base.mk` + `device.mk`. |
| `BoardConfig.mk` | riscv64 target, vendor sepolicy dir, kernel fragment/DTS pointers. |
| `device.mk` | Copies init/fstab and the e1 NPU VINTF fragment. |
| `manifest.xml` | Reserved for full-device VINTF entries once matching services are packaged. |
| `init.eliza.rc` | `/dev/e1-npu` ownership; gates e1_npu on `vendor.e1_npu.ready=1`. |
| `fstab.eliza` | `/vendor` + `/data`. AVB flags are commented as not-yet-implemented. |
| `sepolicy/file_contexts` | Labels the two HAL binaries and `/dev/e1-npu`. |
| `sepolicy/e1_npu.te` | Domain + minimal allow rules, no neverallow violations. |
| `hal/e1_npu/` | C++ stub of the NPU HAL service, fail-closed. |
| `hal/hwcomposer/` | Framebuffer-only hwcomposer stub. |
| `kernel/eliza_ai_soc.fragment` | Android kernel config fragment (SELinux, Binder, BINDERFS, ASHMEM/MEMFD, F2FS, ext4, simple-fb). |
| `dts/eliza-e1-android.dts` | Android-facing DTS scaffold, mirrors the platform contract. |

## Local check

```sh
python3 sw/aosp-device/scripts/check_aosp_bsp.py
```

The script asserts that every evidence file required by the BSP audit
exists. When it does not, the target is reported as BLOCKED with the
specific missing files and reason. It never returns success from source
presence alone.
