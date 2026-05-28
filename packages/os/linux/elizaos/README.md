# elizaOS Linux live-build variant

This directory contains the source-controlled live-build variant used for the
legacy multi-arch elizaOS Linux ISO checks.

Profiles:

- `default`: headless Debian live image with the elizaOS agent/runtime payload.
- `gui`: default plus graphical kiosk/desktop packages and seat wiring.
- `secure`: default plus secure profile overlays when present.
- `secure-gui`: secure plus the GUI profile.

Examples:

```bash
ELIZAOS_ARCH=riscv64 ELIZAOS_PROFILE=default ./build.sh
ELIZAOS_ARCH=riscv64 ELIZAOS_PROFILE=gui ./build.sh
```

The riscv64 boot contract uses Debian's removable-media UEFI path
`EFI/boot/bootriscv64.efi`, the `riscv64-linux-gnu` multiarch tuple, and the
`riscv64-unknown-linux-gnu` GNU triplet. Current reference evidence should be
captured against a fresh GUI artifact such as
`out/elizaos-linux-riscv64-gui-<timestamp>.iso`; do not reuse the headless
`out/elizaos-linux-riscv64-default-20260524T030430Z.iso` matrix entry for GUI
kiosk validation.
