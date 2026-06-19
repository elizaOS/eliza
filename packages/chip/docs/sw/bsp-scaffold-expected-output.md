# BSP scaffold audit — expected output

Shared reference for the BSP scaffold audit output. Both the OpenSBI and
U-Boot scaffold READMEs point here so the expected transcript lives in one
place. Run from the package root:

```sh
make software-bsp-check
python3 sw/check_bsp_scaffolds.py boot
```

Until a CPU-capable SoC integration exists, every BSP lane reports a
fail-closed `BLOCKED` with the exact missing-evidence paths:

```text
buildroot BSP check failed:
  - buildroot BSP BLOCKED: missing evidence for external Buildroot image build plus e1 MMIO smoke transcript: docs/evidence/buildroot/eliza_e1_defconfig.log, docs/evidence/buildroot/eliza_e1_image_manifest.txt, docs/evidence/buildroot/e1-mmio-smoke.log
linux BSP check failed:
  - linux BSP BLOCKED: missing evidence for external Linux kernel build, DTB validation, and runtime driver smoke transcript: docs/evidence/linux/eliza_e1_kernel_build.log, docs/evidence/linux/eliza_e1_dtb_check.log, docs/evidence/linux/e1-mmio-smoke.log
aosp BSP check failed:
  - aosp BSP BLOCKED: evidence for external AOSP lunch/vendorimage/VINTF logs, Cuttlefish or equivalent boot transcript, and Android compatibility subset transcripts is incomplete or invalid
opensbi BSP check failed:
  - opensbi BSP BLOCKED: evidence for external OpenSBI build and fw_dynamic handoff transcript is incomplete or invalid
  - missing docs/evidence/linux/opensbi_eliza_build.log
  - missing docs/evidence/linux/opensbi_fw_dynamic_handoff.log
u-boot BSP check failed:
  - u-boot BSP BLOCKED: evidence for external U-Boot build and OpenSBI-to-U-Boot boot-chain transcript is incomplete or invalid
  - missing docs/evidence/linux/u_boot_eliza_build.log
  - missing docs/evidence/linux/u_boot_opensbi_boot_chain.log
boot: scaffold audit
  local command: make software-bsp-check
  expected output: buildroot BSP check passed.; linux BSP check passed.; aosp BSP check passed.
  dependency blocker: CPU-capable SoC integration with RAM, UART, timer, interrupt controller, OpenSBI handoff
  status: clear
```
