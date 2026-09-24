# Persistent Linux image

Debian trixie GNOME disk images, assembled by mkosi 25.3 or newer. From the
repository root, use the pinned container builder:

```bash
make -C packages/os/linux/elizaos build ARCH=amd64 PROFILE=gui
make -C packages/os/linux/elizaos mkosi-summary ARCH=amd64 PROFILE=gui
bun run --cwd packages/os verify:linux
```

Images have an EFI system partition, system and recovery partitions, and a final
home partition that grows on first boot. USB boot/persistence and internal-disk
installation require separate runtime qualification. Secure Boot is unsupported
on riscv64; other release targets require configured signing keys.

For native builders, `../scripts/mkosi-linux-build.py --help` describes artifact,
snapshot, preflight, and evidence arguments. Release mode requires signed desktop
artifacts and the control-broker sources consumed by `mkosi.postinst.chroot`.
Development builds may omit those components and cannot establish release readiness.
