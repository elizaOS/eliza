# riscv64 GUI Support

elizaOS Live is the only Linux distro source of truth. riscv64 support must
land here, not in a parallel Debian live-build tree.

The riscv64 GUI contract is:

- boot through UEFI/OpenSBI on QEMU `virt`;
- expose a graphical framebuffer with `virtio-gpu-pci`;
- provide USB keyboard and tablet input;
- keep the normal elizaOS desktop app as the home surface;
- use Node mode for the staged agent when the riscv64 Bun artifact is not
  provenance-clean;
- verify native riscv64 CPU artifacts with `bun run verify:riscv64`.

The current CI-verifiable portion is the native artifact buildpath plus this
variant's static smoke. Full riscv64 ISO boot evidence remains hardware/QEMU
host gated and must be recorded against `packages/os/linux/variants/elizaos/`
when produced.
