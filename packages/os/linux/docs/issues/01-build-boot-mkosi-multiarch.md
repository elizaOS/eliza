# linux(mkosi): build and boot canonical x86_64, arm64, and riscv64 images

Repository: `elizaOS/os`

Suggested labels: `linux`, `release-blocker`, `mkosi`, `qemu`, `multiarch`

## Problem

The canonical mkosi tree passes static checks but has not produced or booted an
image. macOS cannot execute mkosi's Linux namespace path, and the current Mac
has no Linux VM/container or QEMU runtime. On Apple Silicon, the reviewed local
bootstrap is `linux/elizaos/scripts/mkosi-macos-lima.sh`: it uses a
native Debian 13 Lima VZ VM, keeps source read-only and build scratch on the VM
disk, and exposes only native arm64 assembly. It does not replace native x86_64
or physical-device release qualification.

## Required environment

- Native Linux x86_64 runner with hardware virtualization.
- Native Linux arm64 runner for the ARM release artifact.
- QEMU system emulators, OVMF/EDK2, swtpm, systemd-repart, zstd, and mkosi at
  the version required by `mkosi.conf`.
- Registered qemu-user/binfmt only for development cross-builds; promoted
  x86_64 and arm64 images must also be built on their native architecture.
- External desktop artifact verification key and signed artifact fixture.

## Work

1. Build each architecture from immutable OS and Eliza commits.
2. Retain mkosi summary, package manifest, repart definitions, build log,
   checksums, firmware/QEMU versions, and output digest.
3. Boot through UEFI; additionally boot x86_64 through legacy BIOS.
4. Prove GDM, owner creation, GNOME Wayland, networking, persistent home
   growth, recovery boot, and clean reboot.
5. Boot the exact raw image as removable USB storage, not only as a virtio root
   disk.
6. Run a second isolated build and compare root filesystem output. Investigate
   unexplained differences with diffoscope.

## Commands

```bash
make -C linux/elizaos mkosi-lint
make -C linux/elizaos mkosi-summary ARCH=amd64
make -C linux/elizaos mkosi-build ARCH=amd64 MKOSI_EMIT_ISO=0
make -C linux/elizaos mkosi-build ARCH=arm64 MKOSI_EMIT_ISO=0
make -C linux/elizaos mkosi-build ARCH=riscv64 MKOSI_EMIT_ISO=0

python3 linux/elizaos/scripts/mkosi-linux-build.py \
  --architecture amd64 \
  --output-dir /var/tmp/elizaos-mkosi-amd64 \
  --evidence /var/tmp/elizaos-evidence/amd64-build.json

python3 linux/elizaos/scripts/mkosi-qemu-qualify.py \
  --architecture amd64 \
  --image /var/tmp/elizaos-mkosi-amd64/elizaos-linux-x86-64.raw \
  --firmware-code /path/to/OVMF_CODE.fd \
  --firmware-vars /path/to/OVMF_VARS.fd \
  --transcript /var/tmp/elizaos-evidence/amd64-qemu.log \
  --evidence /var/tmp/elizaos-evidence/amd64-qemu.json
```

Use the checked-in qualification script when present; do not manually invent a
passing evidence JSON document.

## Acceptance criteria

- Three `.raw.zst` artifacts exist and match the release manifest.
- All three reach graphical GNOME and retain state across reboot.
- Recovery boots with Eliza agent and privileged broker unavailable.
- x86_64 passes UEFI and BIOS; arm64 and riscv64 pass their documented UEFI
  removable boot paths.
- A corrupt root, missing or modified desktop manifest/archive signature,
  wrong architecture artifact, and stale release sequence each fail closed.
- Evidence archive names the exact commits and image digests.
