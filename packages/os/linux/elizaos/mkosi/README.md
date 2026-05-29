# elizaOS Linux — mkosi build path (additive)

A parallel build path for the elizaOS Linux image built on
[systemd/mkosi](https://github.com/systemd/mkosi) instead of live-build.
Reuses the existing `config/includes.chroot/` skeleton, the
`config/hooks/normal/*.hook.chroot` chroot hooks, and the same systemd
units / kiosk wiring — so the kiosk boot chain
(`graphical.target → seatd → elizaos-kiosk → cage → elizaOS app`) is
identical on both build paths.

This path is **additive**. The live-build path under `../` remains the
source of truth for release artifacts until mkosi has equivalent boot
evidence on all three target arches (amd64, arm64, riscv64).

## Why mkosi

- **One small config tree**, not 21 directories of live-build state.
- **Incremental rebuilds** via `--incremental` keep the bootstrap and base
  rootfs cached between iterations (live-build pulls multi-GB on every clean
  build).
- **First-class systemd-repart output**: GPT image with ESP + verity-friendly
  root partition, ready for `systemd-sysupdate` A/B updates later.
- **Native cross-arch via qemu-user binfmt** (same primitive live-build
  uses, but driven by mkosi without extra bootstrap shims).
- **RISC-V grub-efi is supported natively** by mkosi's grub bootloader path
  (no equivalent of the live-build `binary_grub-efi` riscv64 patch).

## Tree layout

```
mkosi/
  mkosi.conf                         # base: distribution=debian trixie, format=disk
  mkosi.conf.d/
    10-arch-amd64.conf               # [Match Architecture=x86-64]
    10-arch-arm64.conf               # [Match Architecture=arm64]
    10-arch-riscv64.conf             # [Match Architecture=riscv64]
  mkosi.profiles/
    gui/mkosi.conf                   # selected by --profile=gui
    secure/mkosi.conf                # selected by --profile=secure
    secure-gui/mkosi.conf            # selected by --profile=secure-gui
  mkosi.skeleton/
    etc -> ../../config/includes.chroot/etc   # one source of truth
    usr -> ../../config/includes.chroot/usr
  mkosi.postinst                     # runs ../config/hooks/normal/*.hook.chroot
  mkosi.finalize                     # sha256 sidecars + optional ISO wrap
  README.md
```

Architecture × profile reach the same package set as the matching
`config/package-lists/elizaos-<arch>.list.chroot` plus
`config/profiles/<profile>/package-lists/*.list.chroot`. The mkosi configs
mirror those lists explicitly (mkosi has no live-build `#if ARCHITECTURES`
preprocessor; arch gating is done by `[Match]` instead).

## Build

```sh
# default profile, x86_64 disk image
make mkosi-build ARCH=amd64

# arm64 GUI/kiosk image (ISO wrap default-on; pass MKOSI_EMIT_ISO=0 to skip)
make mkosi-build ARCH=arm64 PROFILE=gui

# riscv64 GUI/kiosk image — full Debian GUI on RISC-V
make mkosi-build ARCH=riscv64 PROFILE=gui

# secure-gui (composed as a flat mkosi profile)
make mkosi-build ARCH=amd64 PROFILE=secure-gui
```

Outputs land in `../out/mkosi/`:

- `elizaos-linux-<arch>[-<profile>].raw[.zst]` — bootable GPT disk image,
  systemd-repart-style partitioning (ESP + root).
- `elizaos-linux-<arch>[-<profile>].iso` — hybrid ISO (only when
  `MKOSI_EMIT_ISO=1`, which is the Makefile default).
- `*.sha256` — sidecar for each artifact.
- `*.manifest` — mkosi JSON manifest.

A clean mkosi build is slower than an incremental one but still typically
beats a clean live-build build because the package cache is reused.
Incremental rebuilds are dramatically faster.

## Inspect the assembled config (no build)

```sh
make mkosi-summary ARCH=riscv64 PROFILE=gui
```

This runs `mkosi summary` and prints the composed configuration with all
matched overlays applied — useful for verifying that a new arch/profile
combination resolves to the package set you expect.

## Static lint

```sh
make mkosi-lint
```

Checked by the top-level `make lint` automatically. Validates tree shape,
executable bits, skeleton symlink targets, and that every config has an INI
section header. Cheap; safe for CI.

## Kiosk / app-launcher contract

The kiosk wiring is identical to the live-build path because it comes from
the same files:

- `mkosi.skeleton/etc/systemd/system/elizaos-kiosk.service` — runs cage as
  user `user`, which execs the elizaOS app fullscreen.
- `mkosi.postinst` runs the chroot hooks in numeric order; the
  `0025-enable-graphical-session.hook.chroot` masks gdm3, enables
  `seatd.service` + `elizaos-kiosk.service`, and sets
  `default.target → graphical.target`.

The postinst additionally **fails closed** when `--profile=gui` is passed
but `default.target` is not `graphical.target` after the hooks run — that
catches the failure mode where the GUI packages were silently dropped from
the package list.

## RISC-V notes

Debian trixie ships `cage`, `seatd`, `libwebkit2gtk-4.1-0`, and
`epiphany-browser` on riscv64, so the GUI/kiosk profile on riscv64 uses the
**same** package set as amd64/arm64 (with the riscv64 kernel and
`grub-efi-riscv64`). No riscv64-specific GUI path is required at the
package level — the EDK2/OpenSBI → GRUB EFI → Linux → kiosk chain works
unchanged.

## Status

- [x] mkosi tree scaffolded, lint passing.
- [x] Static smoke (`make lint`) includes mkosi tree validation.
- [ ] First clean mkosi build produced per arch (run outside an
      interactive agent — clean Debian bootstraps take 10+ min each).
- [ ] QEMU boot evidence captured for each arch × profile cell, parallel
      to `evidence/qemu_virt_boot_*.json`.
- [ ] Release-manifest schema extended to accept mkosi `*.raw[.zst]` and
      `*.iso` outputs (no schema change needed if we only ship ISOs).
- [ ] Live-build path retired after mkosi reaches evidence parity on all
      three arches.
