# riscv64: qualify the full elizaOS workstation on named physical boards

Repository: `elizaOS/os`

Suggested labels: `linux`, `riscv64`, `hardware`, `release-blocker`

## Scope

Debian 13 provides an official riscv64 userland, but board firmware, graphics,
and peripheral support are not uniform. Qualify QEMU `virt`, VisionFive 2, and
one additional named board selected from hardware that can run the required
GNOME and network stack.

Software rendering is acceptable for v1. It must use the same GTK/WebKit shell,
tray, overlay, Cloud, computer-use, and control topology as other
architectures—not an Epiphany or kiosk fallback.

## Acceptance criteria

- `BOOTRISCV64.EFI` reaches GRUB, Debian, GDM, and GNOME.
- Native riscv64 desktop/agent artifacts pass signature and architecture
  verification.
- Tray, overlay, Cloud sign-in/chat, browser, phone remote, arbitrary-root
  operation, persistence, update, and recovery pass.
- Display, input, Ethernet/Wi-Fi where present, USB, storage, clock, reboot, and
  clean shutdown are documented per board.
- Performance with software rendering is measured and the minimum usable
  hardware is published.
- Secure Boot is explicitly marked unsupported unless a separately reviewed
  trust-root implementation is delivered.
- Marketing names only the qualified boards; it does not claim universal
  RISC-V hardware support.
