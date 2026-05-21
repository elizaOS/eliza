# OpenSBI port scaffold

The full SoC target should boot through OpenSBI before U-Boot and Linux.

The e1 chip currently has no CPU. OpenSBI integration starts once the
Chipyard/Rocket subsystem exists and `sw/platform/e1_platform_contract.json`
has RAM, UART, timer, interrupt-controller, and boot-handoff entries for a
CPU-capable target.

Repo-local command and expected fail-closed output:
[../bsp-scaffold-expected-output.md](../bsp-scaffold-expected-output.md).

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
