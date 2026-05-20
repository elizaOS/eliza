# elizaOS Debian RISC-V 64 Status

**Date:** 2026-05-20
**Claim boundary:** `status_report_view_only_no_silicon_or_boot_claim`

This variant defines the Debian Trixie riscv64 live-build path, the
qemu-virt evidence harness, and the local elizaOS agent startup contract.
It does not claim physical-board or silicon boot evidence.

## Release Gate

Use the variant-local gate before promoting a manifest:

```sh
make -C packages/os/linux/variants/elizaos-debian-riscv64 release-check
make -C packages/os/linux/variants/elizaos-debian-riscv64 release-check-strict
```

Promoted artifacts must include collected evidence for:

- `qemu-virt-boot`
- `grub-efi-riscv64-boot`
- `elizaos-agent-live`

`elizaos-agent-live` requires `elizaos-agent.service` active and
`http://127.0.0.1:31337/api/health` responding from the boot target.

## Build Inputs

The live-build chroot must receive the agent/runtime artifacts described
in `README.md`:

- `/opt/elizaos-artifacts/elizaos-agent-riscv64/elizaos`
- `/opt/elizaos-artifacts/bun-linux-riscv64-musl.zip`
- `/opt/elizaos-artifacts/bun-linux-riscv64-musl.zip.sha256`

The build fails if those artifacts are absent or hash-invalid.

## Commands

```sh
make -C packages/os/linux/variants/elizaos-debian-riscv64 build-image
make -C packages/os/linux/variants/elizaos-debian-riscv64 build
make -C packages/os/linux/variants/elizaos-debian-riscv64 qemu-boot
make -C packages/os/linux/variants/elizaos-debian-riscv64 release-check-strict
```

The full ISO build and qemu boot are long-running external evidence steps;
unit tests can run locally without producing release evidence:

```sh
make -C packages/os/linux/variants/elizaos-debian-riscv64 qemu-virt-boot-test
make -C packages/os/linux/variants/elizaos-debian-riscv64 release-check-test
```
