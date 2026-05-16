# QEMU quickstart

Use QEMU for the canonical VM harness. The scripted path is Linux-first because
`scripts/boot.sh` uses KVM acceleration and QMP sockets for headless tests.

## Requires hardware/platform

- Linux host on an x86_64 CPU.
- `/dev/kvm` access for the fast scripted harness.
- `qemu-system-x86_64`, `qemu-img`, and the tools used by `scripts/build-base.sh`.

Metadata generation does not require any of this hardware:

```bash
cd packages/os/linux
vm/scripts/package-metadata.sh
```

## Build and boot

```bash
cd packages/os/linux
vm/scripts/build-base.sh
vm/scripts/boot.sh --headless --snapshot
```

For an interactive window:

```bash
cd packages/os/linux
vm/scripts/boot.sh --gui --snapshot
```

## Notes

- `--snapshot` is the default and keeps the base qcow2 clean.
- SSH is forwarded to `localhost:2222`.
- The QEMU smoke tests are the only supported CI path today.
