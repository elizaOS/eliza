# Boot Chain: OpenSBI, U-Boot, AVB on RV64

Date: 2026-05-19. Upstream status of the firmware stack relevant to Eliza
E1 boot. Companion to `docs/arch/boot.md`, `docs/arch/boot-rom-spec.md`,
and `docs/sw/opensbi/`, `docs/sw/u-boot/`.

## Reference boot flow (RV64 Linux on a modern SoC)

```text
hart reset
 -> Boot ROM (M-mode)
    - verify next stage (signature, rollback index)
    - DRAM training (or pass to SPL)
    - jump to ZSBL / SPL (M-mode)
 -> SPL (Secondary Program Loader)
    - finalize DRAM, basic clocks
    - load OpenSBI + U-Boot proper into DRAM
    - hand off to OpenSBI (M-mode)
 -> OpenSBI FW_DYNAMIC or FW_JUMP (M-mode)
    - SBI services live in M-mode for the life of the system
    - drop to S-mode and jump to U-Boot proper
 -> U-Boot proper (S-mode)
    - distroboot / EFI app / fitImage
    - select boot slot (A/B), verify AVB chain
    - load Linux kernel + DTB + initramfs into DRAM
    - jump to kernel (still S-mode; OpenSBI stays in M-mode)
 -> Linux kernel (S-mode)
    - calls SBI for IPI/RFENCE/HSM/TIME/PMU/NACL services
```

Eliza E1's current boot ROM scaffold in `fw/boot-rom` is intentionally
upstream of this flow: it is an identity-only contract ROM that jumps to
DRAM at `0x8000_0000`. `docs/arch/boot.md` records the explicit gap: no
DRAM init, no OpenSBI, no AVB, no signature check.

## OpenSBI 1.x

- Active release line: OpenSBI 1.5 (May 2024), 1.6 (Q4 2024); 2.0 is in
  flight on the lists. Generic platform (`platform/generic`) consumes the
  DTB and supports most RV64 boards, including qemu-virt, the software
  reference target named in `docs/arch/boot.md`.
- **Payload modes**:
  - `FW_JUMP`: OpenSBI is M-mode, jumps to a fixed S-mode address. Used
    when the next-stage loader is loaded by a previous bootloader (e.g.
    QEMU `-bios opensbi -kernel u-boot`).
  - `FW_DYNAMIC`: OpenSBI receives a `fw_dynamic_info` struct in a2
    describing the next-stage address, mode, version. Standard for U-Boot
    SPL + OpenSBI handoff.
  - `FW_PAYLOAD`: OpenSBI binary embeds the next stage; one-blob model.
    Useful for the Eliza minimum-Linux QEMU smoke; not preferred for
    production because it couples firmware and kernel images.
- The Eliza E1 contract chain should target FW_DYNAMIC. The scaffold at
  `docs/sw/opensbi/capture-opensbi-evidence.sh` is the right hook for a
  qemu-virt FW_DYNAMIC capture; today it is a no-op pending an actual
  external OpenSBI checkout + build artifact.

## SBI specification

- **SBI v0.1**: legacy ecalls; effectively dead.
- **SBI v0.2/v0.3**: structured extension model, base extension, TIME, IPI,
  RFENCE, HSM (hart state management), SRST (system reset).
- **SBI v1.0** (2021): formalized base extension and pre-existing v0.2/v0.3
  extensions.
- **SBI v2.0** (ratified 2023): adds PMU (performance monitoring),
  Suspend (SUSP), Debug Console (DBCN), CPPC, NACL (Nested Acceleration),
  STA (Steal-Time Accounting, listed in v3.0 draft as well).
- **SBI v3.0 draft** (2025): FWFT (firmware features), SSE (Software
  System Events), MPXY (message proxy), expanded NACL, expanded STA.

Eliza E1 SBI dependencies as Linux comes up:
- Base + TIME + IPI + RFENCE + HSM: mandatory for SMP and timer.
- SRST: required so Android can request system reboot.
- DBCN: required so Linux earlycon=sbi works before any UART driver.
- PMU + Sscofpmf: required for perf / perfetto. See `linux_riscv_state.md`.
- NACL: required only if KVM-RV with H-extension is enabled.

## U-Boot RV64

- `arch/riscv` in U-Boot supports SPL + proper boot for SiFive HiFive
  Unmatched, StarFive VisionFive 2, Microchip PolarFire SoC, T-Head TH1520,
  Allwinner D1, Andes AX25, plus the qemu-virt reference.
- EFI_LOADER subsystem boots distros via `/EFI/BOOT/BOOTRISCV64.EFI` (per
  UEFI specification). Debian, Fedora, openSUSE, Ubuntu all use this path.
- DistroBoot scripts (`boot.scr.uimg`) work as a fallback when the rootfs
  ships a `/boot/extlinux/extlinux.conf` or a `boot/grub/grub.cfg`.
- OpenSBI handoff: U-Boot SPL builds with `OPENSBI=fw_dynamic.bin` and
  drops to S-mode automatically.
- AVB integration: `cmd/avb.c` provides `avb` subcommands (init, verify,
  read_rb, write_rb). Combined with `eficonfig` for slot management this
  is the AOSP-compatible verified boot path on RV64.

## Android Verified Boot (AVB 2.0)

- `external/avb` (`libavb`) defines the vbmeta structure: top-level vbmeta
  partition describes hash descriptors for boot, init_boot, vendor_boot,
  dtbo, system, vendor partitions; chain partitions delegate to per
  partition vbmeta.
- Rollback indices stored in tamper-evident storage (RPMB or fuses).
- Trust anchor: a public key fused into the SoC root of trust or BootROM.
- Android 13+ requires init_boot.img (generic ramdisk) + boot.img (kernel)
  + vendor_boot.img (vendor ramdisk + DTBs) layout. AVB covers all of
  these.
- The Eliza E1 secure-boot contract in `docs/arch/boot.md` correctly
  enumerates the missing pieces: signature verification, rollback indices,
  A/B slots, recovery / OTA, fail-closed before mutable firmware runs.
  None of these is implemented today.

## QEMU-virt reference and gate

- QEMU `virt` machine with `-bios opensbi -kernel u-boot.bin -drive
  if=virtio,format=raw,file=rootfs.ext4` is the canonical RV64 software
  reference path.
- `docs/arch/android-contract.md` already names qemu-virt as the
  software reference target. Eliza E1 must produce captures for:
  - OpenSBI boot banner with platform + spec version (FW_DYNAMIC mode)
  - U-Boot boot banner with `arch riscv` and `efi_loader` available
  - Linux kernel boot to login prompt with serial console via earlycon=sbi
- The capture hooks already exist as no-op scaffolds:
  - `docs/sw/opensbi/capture-opensbi-evidence.sh`
  - `docs/sw/u-boot/capture-u-boot-evidence.sh`
- The Cuttlefish RV64 path follows the same chain but inside crosvm.

## Recommendations for Eliza E1

1. Treat `fw/boot-rom` as a contract ROM only and adopt OpenSBI + U-Boot
   for any S-mode-and-up boot. Do not grow the boot ROM into a Linux
   loader; keep it minimum: verify next stage, hand off, fail closed.
2. Use FW_DYNAMIC for the OpenSBI -> U-Boot handoff. Avoid FW_PAYLOAD
   so kernel updates do not require firmware rebuild.
3. Target SBI v2.0 plus Sscofpmf and DBCN as the floor. Track v3.0
   draft extensions (FWFT, SSE, MPXY) as optional follow-ons.
4. Build U-Boot with `CONFIG_EFI_LOADER=y` so Debian/Fedora RV64 boot
   on the same firmware as Android via `BOOTRISCV64.EFI`. This keeps
   the Buildroot/Yocto/distro path open for `make minimum-linux-npu-target`.
5. Implement AVB 2.0 against a fused root-of-trust key. Map the
   `boot-rom-spec.md` "policy fuses" abstractly to RPMB / OTP slots
   and write tests for rollback index enforcement before any retail
   build.
6. The Eliza E1 `make aosp-bsp-check` gate should require captures from
   the qemu-virt OpenSBI/U-Boot stack first, then the Cuttlefish RV64
   crosvm stack, before requiring native silicon boot evidence.
