# desktop(linux): ship one GTK/WebKit shell on x86_64, arm64, and riscv64

Repository: `elizaOS/eliza`

Suggested labels: `desktop`, `linux`, `riscv64`, `release-blocker`

## Problem

The OS requires the same tray, overlay, and agent experience on all three
architectures. The current Electrobun Linux toolchain does not provide the
required riscv64 artifact, and a browser/kiosk fallback is not parity.

## Work

Build a first-party GTK/WebKitGTK Linux shell that reuses the existing renderer
and agent APIs. Produce signed `tar.zst` artifacts satisfying
`linux/schemas/desktop-artifact-manifest.schema.json` in the OS
repository.

Required features: tray/AppIndicator, overlay, deep links, notifications,
close-to-tray, system-browser OAuth, Secret Service, Wayland portals, global
shortcuts, PipeWire/ScreenCast, AT-SPI, local control socket, update handoff,
doctor command, and software rendering.

## Acceptance criteria

- Native artifacts exist for x86_64, arm64, and riscv64 from one source and UI
  topology.
- Manifest entrypoints and archive digest verify before OS integration.
- The producer emits the fixed adjacent
  `desktop-artifact-manifest.json.sig` over the exact manifest bytes and a
  separate manifest-named signature over the exact archive bytes.
- GNOME Wayland packaged tests cover first launch, sign-in, tray, overlay,
  restart, upgrade, multi-user isolation, portal denial/revocation, and software
  rendering.
- No architecture uses Epiphany, Cage, an embedded client secret, or a
  root-running renderer/model/plugin process.
