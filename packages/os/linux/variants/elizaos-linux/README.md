# elizaOS Linux

A single Debian-based live ISO build that targets **x86_64 (amd64), arm64,
and riscv64** from one live-build configuration. It replaces the earlier
per-arch trees with one config whose architecture-specific bits are
selected at build time.

## How multi-arch works

There is one `auto/config`, one set of hooks, and one branding overlay.
Architecture is chosen with `ELIZAOS_ARCH` (`amd64` | `arm64` | `riscv64`,
default `amd64`) and drives `lb config --architecture/--linux-flavours`.
Per-arch package differences live in live-build's native
architecture-suffixed package lists:

```
config/package-lists/
  elizaos-common.list.chroot         # installed on every arch
  elizaos-amd64.list.chroot.amd64    # amd64 only
  elizaos-arm64.list.chroot.arm64    # arm64 only
  elizaos-riscv64.list.chroot.riscv64# riscv64 only
```

All three arches boot via GRUB EFI; amd64 also gets BIOS via `grub-pc`.

## Profiles

`ELIZAOS_PROFILE` selects a hardening profile:

- `default` — plain Debian live desktop with the elizaOS app as the home
  surface.
- `tails-secure` — **amd64 only.** Overlays a Tails-derived amnesia / Tor /
  MAC-spoofing hardening set on top of the default config. The profile
  overlay is composed in by `build.sh` from `config/profiles/tails-secure/`.

> Status: the `tails-secure` overlay directory is not yet populated in this
> tree; `build.sh` applies it only when present, so a `PROFILE=tails-secure`
> build currently produces the default config. Tracking its hardening
> package list + chroot hooks as the next step.

## Build

The only host requirement is Docker.

```sh
make build ARCH=amd64                       # x86_64 ISO
make build ARCH=arm64                        # arm64 ISO
make build ARCH=riscv64                       # riscv64 ISO
make build ARCH=amd64 PROFILE=tails-secure    # hardened amd64
make qemu-boot ARCH=riscv64                    # boot newest ISO in QEMU
make brand-assets                              # regenerate PNG branding from SVG
make lint                                      # static smoke checks
make clean                                     # remove out/ + live-build state
```

`make build` runs `lb config` → `lb build` → verify → checksum → manifest
inside the builder container (`Dockerfile`). A clean build pulls multi-GB
from Debian mirrors and takes 30+ minutes; do not run it from an
interactive agent. Outputs land in `out/`:

- `elizaos-linux-<arch>-<profile>-<ts>.iso`
- `elizaos-linux-<arch>-<profile>-<ts>.iso.sha256`
- `elizaos-linux-<arch>-<profile>-<ts>.manifest.json`

## Branding

`scripts/generate-elizaos-brand-assets.sh` renders the raster branding
(wallpaper, GRUB splash, Plymouth wordmark, greeter logo) from the SVG
sources in `assets/` using ImageMagick. The PNGs are staged into
`config/includes.chroot/usr/share/...` and wired as defaults by
`config/hooks/normal/0030-elizaos-branding.hook.chroot`.

## Release evidence

`scripts/check_release_manifest.py` validates a filled `manifest.json`
against the schema at `packages/os/release/schema/`. It is fail-closed:
informational by default, `release-check-strict` for the release pipeline.
No promoted artifact exists yet — the manifest template carries
`provenance: scaffolding` until a real build replaces it.

## Status

This is the active, canonical Linux build. The build pipeline, multi-arch
config, branding overlay, and release-manifest gate are in the tree. Not yet
done: a produced+validated ISO per arch, the `tails-secure` profile overlay,
and full brand-asset path validation against a real chroot. See
`packages/os/CLAUDE.md` for the distribution-channel and promotion policy.

## License

Debian/live-build components: GPL-3.0-or-later. The `tails-secure` profile
derives from Tails (https://tails.net/), GPL-3.0-or-later; upstream
attribution is preserved in the profile's credit files. elizaOS additions
are Apache-2.0 where separable, dual-licensed where required.
