# OpenSBI port scaffold

The full SoC target should boot through OpenSBI before U-Boot and Linux.

The e1 chip currently has no CPU. OpenSBI integration starts once the
Chipyard/Rocket subsystem exists and `sw/platform/e1_platform_contract.json`
has RAM, UART, timer, interrupt-controller, and boot-handoff entries for a
CPU-capable target.

Repo-local command:

```sh
make software-bsp-check
python3 sw/check_bsp_scaffolds.py boot
```

Expected output:

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

Dependency blocker: a real OpenSBI build requires a CPU-capable SoC integration
with reset vector, RAM, UART, timer, interrupt controller, and a selected
OpenSBI platform or generic `fw_dynamic` handoff. Until then this directory is
documentation-only and must not be treated as boot evidence.

## External Evidence Capture

The capture script records `EXTERNAL_TREE`, `COMMAND`, `START_UTC`, `END_UTC`,
`RESULT`, and the `eliza-evidence` PASS/FAIL envelope. Run it only against
a real external OpenSBI checkout and a real simulator or board handoff command:

```sh
sw/opensbi/scripts/import-opensbi-platform.sh --check /path/to/opensbi
ELIZA_OPENSBI_CMD='make PLATFORM=generic FW_DYNAMIC=y' \
  docs/sw/opensbi/capture-opensbi-evidence.sh /path/to/opensbi build
ELIZA_OPENSBI_HANDOFF_CMD='/exact/qemu-or-renode fw_dynamic handoff command' \
  docs/sw/opensbi/capture-opensbi-evidence.sh /path/to/opensbi handoff
python3 scripts/check_software_bsp.py opensbi --require-evidence
```

To check local tree discovery, host toolchain readiness, and the exact
remaining commands without creating substitute logs:

```sh
python3 scripts/check_software_bsp.py external-preflight opensbi \
  --opensbi /path/to/opensbi \
  --opensbi-handoff-cmd '/exact/qemu-or-renode fw_dynamic handoff command' \
  --write-report
```
