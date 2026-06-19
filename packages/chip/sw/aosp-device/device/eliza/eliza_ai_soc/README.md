# eliza_ai_soc AOSP device tree (v0)

Backing contract: `sw/platform/e1_platform_contract.json`.

This directory is an Android device tree package for an external AOSP
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
m vendorimage        # builds /vendor with the fail-closed e1 NPU HAL
```

Expected first-pass artifacts (capture as evidence under
`docs/evidence/android/`):

```
out/target/product/eliza_ai_soc/vendor.img
out/target/product/eliza_ai_soc/installed-files-vendor.txt
out/target/product/eliza_ai_soc/vendor/etc/vintf/manifest/eliza_e1.xml
```

`make aosp-bsp-check` and `python3 sw/aosp-device/scripts/check_aosp_bsp.py`
stay evidence-gated until those logs are checked in.

## What this v0 device actually claims

Only the fail-closed NPU service is installed in the current vendorimage
evidence path. The local legacy composer source remains checked in for audit
history but is not packaged by the current riscv64 Cuttlefish-derived product.

| HAL package | Backing node | Behavior |
|---|---|---|
| `vendor.eliza.e1_npu@1.0-service` | `/dev/e1-npu` | Fail-closed. Returns `NOT_SUPPORTED` when the node is absent; otherwise the single `smoke()` RPC validates the kernel contract and runs deterministic RELU4/GEMM_S8 ioctls (`cuttlefish_riscv64`, `qemu_riscv64`, and `renode_e1_soc` paths all use the same kernel driver). |
| inherited Cuttlefish composer3 APEX | virtual display path | Current graphics source for this riscv64 phone product. The local legacy HIDL composer source is retained only as non-packaged audit history. |

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
  keeps AVB flags out of the current evidence claim.
- Google Play / GMS / Play Protect / Play Integrity certification. This
  device is AOSP-only and is not a Play-certified product.

## File map

| File | Purpose |
|---|---|
| `AndroidProducts.mk` | Exposes `eliza_ai_soc-trunk_staging-userdebug` to lunch. |
| `eliza_ai_soc.mk` | Inherits `core_64_bit_only.mk` + `aosp_base.mk` + `device.mk`. |
| `BoardConfig.mk` | riscv64 target, vendor sepolicy dir, kernel fragment/DTS pointers. |
| `device.mk` | Copies init/fstab and the e1 NPU VINTF fragment. |
| `manifest.xml` / `eliza_e1.xml` | Legacy device-manifest fragments. The e1_npu and composer HALs are now declared solely by the per-service `vintf_fragments` in their `hal/*/Android.bp`; these files are no longer wired into `DEVICE_MANIFEST_FILE` (doing so makes libvintf reject the merged manifest with a conflicting-FqInstance error). |
| `init.eliza.rc` | `/dev/e1-npu` ownership; gates e1_npu on `vendor.e1_npu.ready=1`. |
| `fstab.eliza` | `/vendor` + `/data`. AVB flags are outside the current evidence claim. |
| `sepolicy/file_contexts` | Labels the two HAL binaries and `/dev/e1-npu`. |
| `sepolicy/e1_npu.te` | Domain + minimal allow rules, no neverallow violations. |
| `hal/e1_npu/` | C++ NPU HAL service with fail-closed fixed-vector ioctl smoke. |
| `hal/hwcomposer/` | Non-packaged legacy framebuffer composer source retained for migration audits. |
| `kernel/eliza_ai_soc.fragment` | Android kernel config fragment (SELinux, Binder, BINDERFS, ASHMEM/MEMFD, F2FS, ext4, simple-fb). |
| `dts/eliza-e1-android.dts` | Android-facing DTS mirror of the platform contract. |

## Local check

```sh
python3 sw/aosp-device/scripts/check_aosp_bsp.py
```

The script asserts that every evidence file required by the BSP audit
exists. When it does not, the target is reported as BLOCKED with the
specific missing files and reason. It never returns success from source
presence alone.
