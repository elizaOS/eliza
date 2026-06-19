# Software BSP Evidence Capture

This directory is for external command transcripts only. Do not create hand-written
PASS logs. The repo-local gate rejects placeholder, failed, blocked, too-small,
or marker-incomplete files.

List every required artifact, current status, capture command, validation
command, and blocker:

```sh
python3 scripts/check_software_bsp.py status all
```

Generate exact capture commands by supplying the external checkout paths and
runtime command inputs. This prints commands only; it does not create evidence:

```sh
python3 scripts/check_software_bsp.py capture-plan all \
  --buildroot /abs/path/to/buildroot \
  --linux /abs/path/to/linux \
  --opensbi /abs/path/to/opensbi \
  --aosp /abs/path/to/aosp \
  --target-host root@TARGET \
  --opensbi-handoff-cmd '/exact/qemu-or-renode fw_dynamic handoff command' \
  --qemu-smoke-cmd '/exact/qemu-system-riscv64 smoke command' \
  --renode-smoke-cmd '/exact/renode smoke command'
```

Check the local environment and discovered external trees without creating
evidence logs:

```sh
python3 scripts/check_software_bsp.py external-preflight all \
  --linux /abs/path/to/linux \
  --opensbi /abs/path/to/opensbi \
  --buildroot /abs/path/to/buildroot \
  --target-host root@TARGET \
  --opensbi-handoff-cmd '/exact/qemu-or-renode fw_dynamic handoff command' \
  --write-report
```

Run the fail-closed evidence gate after importing real external logs:

```sh
python3 scripts/check_software_bsp.py all --require-evidence
```

The legacy manifest-oriented view is still available as:

```sh
python3 scripts/check_software_bsp.py all --evidence-plan
```

## Buildroot

```sh
sw/buildroot/scripts/capture-buildroot-evidence.sh /path/to/buildroot defconfig
sw/buildroot/scripts/capture-buildroot-evidence.sh /path/to/buildroot image-manifest
E1_SMOKE_CMD='ssh root@TARGET /usr/bin/e1-mmio-smoke' \
  sw/buildroot/scripts/capture-buildroot-evidence.sh /path/to/buildroot smoke
E1_NPU_ML_SMOKE_CMD='ssh root@TARGET /usr/bin/e1-npu-ml-smoke --device /dev/e1-npu' \
  sw/buildroot/scripts/capture-buildroot-evidence.sh /path/to/buildroot ml-smoke
python3 scripts/check_software_bsp.py buildroot --require-evidence
```

## Linux

```sh
sw/linux/scripts/capture-linux-bsp-evidence.sh /path/to/linux kernel-build
sw/linux/scripts/capture-linux-bsp-evidence.sh /path/to/linux dtb-check
E1_SMOKE_CMD='ssh root@TARGET /usr/bin/e1-npu-ml-smoke' \
  sw/linux/scripts/capture-linux-bsp-evidence.sh /path/to/linux smoke
python3 scripts/check_software_bsp.py linux --require-evidence
```

## OpenSBI

```sh
sw/opensbi/scripts/import-opensbi-platform.sh --check /path/to/opensbi
ELIZA_OPENSBI_CMD='make PLATFORM=generic FW_DYNAMIC=y' \
  docs/sw/opensbi/capture-opensbi-evidence.sh /path/to/opensbi build
ELIZA_OPENSBI_HANDOFF_CMD='/exact/qemu-or-renode fw_dynamic handoff command' \
  docs/sw/opensbi/capture-opensbi-evidence.sh /path/to/opensbi handoff
python3 scripts/check_software_bsp.py opensbi --require-evidence
```

## AOSP

```sh
sw/aosp-device/capture-aosp-evidence.sh /path/to/aosp lunch
sw/aosp-device/capture-aosp-evidence.sh /path/to/aosp vendorimage
sw/aosp-device/capture-aosp-evidence.sh /path/to/aosp checkvintf
sw/aosp-device/capture-aosp-evidence.sh /path/to/aosp sepolicy-build
sw/aosp-device/capture-aosp-evidence.sh /path/to/aosp selinux-neverallow
sw/aosp-device/capture-aosp-evidence.sh /path/to/aosp cts-vts-plan
sw/aosp-device/capture-aosp-evidence.sh /path/to/aosp cuttlefish-smoke
AOSP_QEMU_SMOKE_COMMAND='/exact/qemu-system-riscv64 smoke command' \
  sw/aosp-device/capture-aosp-evidence.sh /path/to/aosp qemu-smoke
AOSP_RENODE_SMOKE_COMMAND='/exact/renode smoke command' \
  sw/aosp-device/capture-aosp-evidence.sh /path/to/aosp renode-smoke
python3 scripts/check_software_bsp.py aosp --require-evidence
```

The Cuttlefish, CTS, and VTS logs are bounded virtual-device evidence only.
They do not prove e1_soc hardware boot, CDD compliance, GMS certification,
or full Android compatibility.
