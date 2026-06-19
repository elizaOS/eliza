# Android/Linux/BSP critical gap audit - 2026-05-17

Scope: `sw/**`, `docs/arch/android-contract.md`, `docs/android/riscv-bringup.md`,
`scripts/check_software_bsp.py`, `sw/check_bsp_scaffolds.py`, and the AOSP
product files under `sw/aosp-device/device/eliza/eliza_ai_soc`.

## Executive status

The repository contains useful Android/Linux/Buildroot scaffolds, but no
checked-in evidence that any Linux, Buildroot, AOSP, Cuttlefish, QEMU, or Renode
image has booted with this BSP. Treat all software BSP status as BLOCKED until
the required external-tree logs and smoke transcripts are committed.

`sw/check_bsp_scaffolds.py` remains a source-presence audit. It can be clear
while the real BSP is blocked. `scripts/check_software_bsp.py` is the gate that
must stay BLOCKED until schema-listed evidence exists and passes transcript
marker validation.

## Placeholders and scaffolds

| Area | Checked-in state | Gap |
|---|---|---|
| Platform contract | `sw/platform/e1_platform_contract.json` still has `e1_chip.has_cpu=false` and `boot_vector_placeholder`. | No CPU-capable e1-chip boot target exists. |
| OpenSBI | `docs/sw/opensbi/README.md` is documentation-only. | No platform code, `fw_dynamic` handoff, RAM map, UART, timer, or interrupt proof. |
| U-Boot | `docs/sw/u-boot/README.md` is documentation-only. | No board port, defconfig, SPL/U-Boot image, boot media, or device-tree handoff. |
| Buildroot | `sw/buildroot` is a `BR2_EXTERNAL` skeleton with defconfig, fragment, and rootfs smoke script. | No external Buildroot checkout, no `linux-external.tar.xz`, no kernel/rootfs image, no runtime log. |
| Linux | `sw/linux` has importable NPU/DMA driver sources and DTS. | No external kernel checkout integration, no compiled modules, no DTB build, no boot log, no `/dev/e1-npu` smoke. |
| AOSP | `sw/aosp-device` has product, BoardConfig, device makefile, init, VINTF, fstab, sepolicy, kernel fragment, and DTS scaffolds. | No external AOSP checkout build, no `vendor.img`, no VINTF result, no SELinux build/neverallow result, and no Cuttlefish/QEMU/Renode smoke transcript accepted by the strict gate. |
| Android compatibility | `sw/aosp-device/evidence_manifest.json` lists CTS/VTS scope-intake evidence requirements. | No CTS, VTS, CDD, or Android compatibility logs are checked in; no Android compatibility claim is allowed. |
| WiFi/Bluetooth | Linux DTS has disabled SDIO/UART nodes for a Murata/CYW4343W-class shape. | No SDIO host, UART, GPIO/pinctrl, power sequencing, RF path, firmware loading, or runtime evidence. |

## HAL stubs and Android gaps

| HAL/surface | File evidence | Gap to close |
|---|---|---|
| NPU HAL | `device.mk` declares `e1_npu.default`; `manifest.xml` declares `vendor.eliza.e1_npu@1.0`; init starts it only when `vendor.e1_npu.ready=1`; repo-local HAL source exists under `sw/aosp-device/device/eliza/eliza_ai_soc/hal/e1_npu`. | No external AOSP build has produced the HAL binary; no HIDL/AIDL interface build, VTS result, runtime probe, or fail-closed device smoke transcript is checked in. |
| Graphics composer | `device.mk` declares `android.hardware.graphics.composer@2.4-service` and `hwcomposer.eliza_ai_soc`; `manifest.xml` declares composer 2.4; repo-local framebuffer-only HWC source exists under `sw/aosp-device/device/eliza/eliza_ai_soc/hal/hwcomposer`. | No external AOSP build has produced `hwcomposer.eliza_ai_soc`; no framebuffer or DRM node proof, SurfaceFlinger log, HWC2 validation, or home-screen evidence is checked in. |
| Input | Runbook allows Cuttlefish/evdev only. | No e1_soc touch/input DTS, driver, HAL policy, or CTS input evidence. |
| Audio/camera/radio/GNSS/NFC | Explicitly excluded in docs. | No manifest entries or implementation; must remain excluded from claims. |
| SELinux | `file_contexts` and `e1_npu.te` label the NPU path and HAL domain. | Policy has not been compiled in AOSP, no `checkpolicy`/Soong output, no `avc` log review. |
| Fstab/storage | `fstab.eliza` names vendor and userdata by partition name. | No partition table, boot/vendor/userdata images, AVB chain, or mount log. |

## Missing external trees and images

Required but absent:

- External Linux tree with `drivers/misc/eliza-e1` imported.
- External Buildroot checkout using `sw/buildroot` as `BR2_EXTERNAL`.
- External AOSP checkout with `device/eliza/eliza_ai_soc` imported.
- Cuttlefish host setup with KVM, `launch_cvd`, `adb`, and riscv64 product.
- External AOSP build output proving `e1_npu.default` compiles, installs, and
  passes the repo contract/runtime smoke.
- External AOSP build output proving `hwcomposer.eliza_ai_soc` compiles,
  installs, and reaches SurfaceFlinger with the framebuffer contract.
- Built Linux `Image`, DTB, modules, and boot log.
- Built Buildroot rootfs/kernel image and `e1-mmio-smoke` transcript.
- Built AOSP `vendor.img`, installed-files manifest, VINTF output, SELinux
  policy output, neverallow output, CTS/VTS scope-intake log, and virtual-device
  smoke logs.

## Boot and simulator evidence gaps

| Target | Current evidence | Required evidence before PASS |
|---|---|---|
| AOSP Cuttlefish riscv64 | Legacy `cuttlefish_riscv64_boot.log` may exist from capture tooling, but it is not the strict gate file. | `docs/evidence/android/cuttlefish_riscv64_smoke.log` with provenance, no boot/compatibility claim markers, `ro.product.cpu.abi=riscv64`, `eliza_ai_soc`, and real Cuttlefish/adb smoke output. |
| Eliza AOSP product | Product files only plus any archived lunch log. | `eliza_ai_soc_lunch.log`, `eliza_ai_soc_vendorimage.log`, `eliza_ai_soc_checkvintf.log`, `eliza_ai_soc_sepolicy_build.log`, `eliza_ai_soc_selinux_neverallow.log`, and installed-files/policy evidence. |
| Android compatibility scope | Manifest only; legacy `cts_virtual_device_subset.log` and `vts_virtual_device_subset.log` are aliases when capture tooling creates them. | `eliza_ai_soc_cts_vts_plan.log` from real CTS/VTS build, list, or bounded smoke-scope intake commands; this is still not full CDD/CTS/VTS certification. |
| QEMU virt | Semantic qemu-virt checks and optional smoke path exist, but qemu-virt is not e1-chip ABI proof. | Bounded QEMU UART transcript for software reference, plus separate e1-chip MMIO proof before hardware claims. |
| Renode | Reference platform/check path only; docs state executable smoke is blocked without transcript. | Renode serial transcript loading the real firmware ELF and capturing the expected banner. |
| e1_soc RTL/Linux | No CPU-capable e1_soc boot path. | CPU, RAM, UART, timer, interrupt controller, OpenSBI handoff, Linux boot log, and MMIO smoke. |

## Kernel driver gaps

Implemented as importable source only:

- `eliza,e1-npu` misc char driver reads `E1_NPU_RESULT_OFFSET`.
- `eliza,e1-dma` platform driver exports a sysfs contract string.

Still missing:

- Display driver or simple framebuffer/DRM/KMS implementation.
- Timer/clocksource driver tied to Linux boot.
- Interrupt controller integration and real IRQ resources in DTS.
- GPIO/pinctrl driver.
- SDIO host driver path for WiFi.
- UART Bluetooth transport integration.
- DMA functional operations beyond a contract sysfs node.
- NPU ioctl/runtime ABI, fixed-vector execution path, and negative tests.
- Device-tree binding schemas and `dtbs_check` evidence.
- Module build logs, kernel config proof, boot logs, and userspace smoke logs.

## Machine-readable BLOCK gates

`scripts/check_software_bsp.py` now requires these evidence files through
`docs/android/bsp-log-evidence-manifest.json` and
`docs/android/bsp-artifact-manifest.json`:

| Target | Evidence files |
|---|---|
| Buildroot | `docs/evidence/buildroot/eliza_e1_defconfig.log`, `docs/evidence/buildroot/eliza_e1_image_manifest.txt`, `docs/evidence/buildroot/e1-mmio-smoke.log` |
| Linux | `docs/evidence/linux/eliza_e1_kernel_build.log`, `docs/evidence/linux/eliza_e1_dtb_check.log`, `docs/evidence/linux/e1-mmio-smoke.log` |
| OpenSBI | `docs/evidence/linux/opensbi_eliza_build.log`, `docs/evidence/linux/opensbi_fw_dynamic_handoff.log` |
| U-Boot | `docs/evidence/linux/u_boot_eliza_build.log`, `docs/evidence/linux/u_boot_opensbi_boot_chain.log` |
| AOSP / Android | `docs/evidence/android/eliza_ai_soc_lunch.log`, `docs/evidence/android/eliza_ai_soc_vendorimage.log`, `docs/evidence/android/eliza_ai_soc_checkvintf.log`, `docs/evidence/android/eliza_ai_soc_sepolicy_build.log`, `docs/evidence/android/eliza_ai_soc_selinux_neverallow.log`, `docs/evidence/android/eliza_ai_soc_cts_vts_plan.log`, `docs/evidence/android/cuttlefish_riscv64_smoke.log`, `docs/evidence/android/qemu_riscv64_smoke.log`, `docs/evidence/android/renode_e1_soc_smoke.log` |

Until those files exist with real command transcripts, `make software-bsp-check`
prints BLOCKED status and `make software-bsp-evidence-check` fails. Placeholder
logs, failed transcripts, templates, and files missing required command/pass
markers are rejected.

Backward-compatible aliases from `sw/aosp-device/capture-aosp-evidence.sh` are
`cuttlefish_riscv64_boot.log`, `cts_virtual_device_subset.log`, and
`vts_virtual_device_subset.log`. They may be retained with reports, but they are
not the full AOSP gate required by `scripts/check_software_bsp.py`.

Capture entry points:

- Buildroot: `sw/buildroot/scripts/capture-buildroot-evidence.sh /path/to/buildroot defconfig|image-manifest|smoke`
- Linux: `sw/linux/scripts/capture-linux-bsp-evidence.sh /path/to/linux kernel-build|dtb-check|smoke`
- OpenSBI: `sw/opensbi/capture-opensbi-evidence.sh /path/to/opensbi build|handoff`
- U-Boot: `sw/u-boot/capture-u-boot-evidence.sh /path/to/u-boot build|boot-chain`
- AOSP: `sw/aosp-device/capture-aosp-evidence.sh /path/to/aosp lunch|vendorimage|checkvintf|cuttlefish-boot|cts-subset|vts-subset`, plus `python3 scripts/intake_android_evidence.py --target aosp --from-dir /path/to/logs --install` for the strict nine-log gate
