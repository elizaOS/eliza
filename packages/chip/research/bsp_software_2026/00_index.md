# Linux / Android / AOSP / BSP Software Stack Research Packet

Date: 2026-05-19

This packet records a source-backed survey of the open Linux and Android
software stack required to bring up an open RV64 SoC such as Eliza E1. It is
the counterpart to the CPU subsystem, NPU accelerator, memory subsystem, and
PD/EDA research packets, and it is the upstream input for the scaffolds under
`docs/sw/` (`linux/`, `opensbi/`, `u-boot/`, `buildroot/`, `aosp-device/`) and
for the gate at `docs/project/aosp-simulator-completion-gate.yaml`.

The scope follows the brief: RISC-V Linux kernel state through 6.x, the
Android RISC-V port through AOSP main / Android 16, OpenSBI 1.x / SBI v3.0,
U-Boot RV64 + AVB, Buildroot / Yocto / Debian RV64 userland, AOSP device /
vendor tree shape (Treble, VINTF, AIDL HALs, SELinux), Cuttlefish virtual
device on RV, mainline drivers (DRM/KMS, V4L2, USB, SDHCI, simple-framebuffer,
mac80211, BlueZ), Power/Thermal HAL, KVM RV / hypervisor extension H, eBPF
and Sscofpmf perf, and the AI accelerator HAL story from NNAPI to AICore /
ExecuTorch / LiteRT.

## Files

- `01_sources/source_inventory.yaml` -- provenance, URLs, captured points,
  and claim boundaries. Schema mirrors
  `research/ai_accelerator_sota/01_sources/source_inventory.yaml`.
- `02_analysis/linux_riscv_state.md` -- kernel.org RISC-V tree status,
  RVV 1.0 kernel/userland enablement, KVM RV with H-extension, Sscofpmf
  perfmon, Sv39/Sv48/Sv57 paging, ACPI vs DT on RV server, eBPF on RV64.
- `02_analysis/android_riscv_state.md` -- RISE Project deliverables, Google
  AOSP RV64 main branch state, riscv-android-sig contributions, ART AOT/JIT
  RV64, Bionic/NDK, Cuttlefish RV64 (crosvm), CTS/VTS coverage, Android 14
  through 16 / AOSP main.
- `02_analysis/boot_chain.md` -- OpenSBI 1.x release / SBI v3.0 spec /
  DBCN/SUSP/NACL/STA extensions, FW_JUMP vs FW_DYNAMIC vs FW_PAYLOAD,
  U-Boot RV64 + EFI app loading, OpenSBI handshake, AVB / verified boot
  layering.
- `02_analysis/hal_and_drivers.md` -- DRM/KMS (simple-framebuffer, Panfrost,
  Etnaviv, freedreno), V4L2, USB host/device, SDHCI / dwcmshc, mac80211 /
  nl80211 / hostapd, BlueZ + Gabeldorsche, Power HAL 4.x AIDL, Thermal HAL
  2.x, EAS / schedutil / sched_pelt.
- `02_analysis/ai_accelerator_hal.md` -- NNAPI deprecation in Android 15,
  AICore stack in Android 16, AIDL HAL design for an open NPU, TF Lite /
  LiteRT delegate path, ExecuTorch runtime, MediaPipe Tasks.
- `03_implementation/bsp_path_for_e1.md` -- ranked recommendations tied to
  `docs/sw/linux/`, `docs/sw/opensbi/`, `docs/sw/u-boot/`,
  `docs/sw/buildroot/`, `docs/sw/aosp-device/`,
  `docs/arch/android-contract.md`, `docs/arch/boot.md`,
  `docs/arch/boot-rom-spec.md`, and the
  `docs/project/aosp-simulator-completion-gate.yaml` evidence list.

## Claim Boundary

This packet is research and implementation-planning evidence. Linked sources
are public release notes, mailing-list archives, RFCs, AOSP commits, vendor
device-tree examples, and project documentation. They are upstream-status
evidence only; they do not prove E1 software bring-up. Boot, kernel,
userspace, CTS/VTS, and HAL claims require local execution evidence that
must land through `make aosp-bsp-check`,
`scripts/check_aosp_simulator_completion_gate.py`,
`scripts/capture_cpu_ap_evidence.py`,
`docs/sw/opensbi/capture-opensbi-evidence.sh`, and
`docs/sw/u-boot/capture-u-boot-evidence.sh` per the gates already in tree.

The current scaffolds in `docs/sw/` are placeholders pending those external
captures; no claim in this packet promotes them past their `blocked` state.
