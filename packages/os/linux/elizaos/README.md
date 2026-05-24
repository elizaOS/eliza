# elizaOS Linux

A single Debian-based live ISO build that targets **x86_64 (amd64), arm64,
and riscv64** from one live-build configuration. It replaces the earlier
per-arch trees with one config whose architecture-specific bits are
selected at build time.

## How multi-arch works

There is one `auto/config`, one set of hooks, and one branding overlay.
Architecture is chosen with `ELIZAOS_ARCH` (`amd64` | `arm64` | `riscv64`,
default `amd64`) and drives `lb config --architecture/--linux-flavours`.
Per-arch package differences are expressed with live-build's in-file
`#if ARCHITECTURES` conditional. live-build only reads package lists whose
names match `*.list`, `*.list.chroot`, or `*.list.chroot_<install|live>`;
an arch suffix like `.amd64` matches none of those globs and is silently
skipped (this previously dropped the entire desktop). So every list uses a
plain `.list.chroot` name and gates its arch-specific body instead:

```
config/package-lists/
  elizaos-common.list.chroot     # installed on every arch (no guard)
  elizaos-amd64.list.chroot      # body wrapped in #if ARCHITECTURES amd64
  elizaos-arm64.list.chroot      # body wrapped in #if ARCHITECTURES arm64
  elizaos-riscv64.list.chroot    # body wrapped in #if ARCHITECTURES riscv64
```

How the guard works (live-build's `Expand_packagelist`): a line
`#if ARCHITECTURES <arch>` enables the following lines only when
`LB_ARCHITECTURES` (set from `lb config --architecture <arch>`) contains
`<arch>`; a matching `#endif` re-enables emission. On a non-matching arch
the whole block is skipped. Conditionals must not be nested.

All three arches boot via GRUB EFI; amd64 also gets BIOS via `grub-pc`.
riscv64 uses Debian's `grub-efi-riscv64` package plus
`grub-efi-riscv64-bin` modules, and the builder patches live-build's
`binary_grub-efi` helper until the upstream live-build script has native
riscv64 EFI image generation. On QEMU `virt`, the tested chain is
EDK2/OpenSBI firmware -> `EFI/boot/bootriscv64.efi` -> GRUB -> Linux live
kernel/initrd. Board-specific firmware can sit below that chain, but the
Debian live ISO contract stays UEFI/GRUB rather than a separate ad hoc
bootloader path.

The RISC-V port contract follows Debian's riscv64 port metadata: GNU triplet
`riscv64-unknown-linux-gnu`, multiarch tuple `riscv64-linux-gnu`, and the
UEFI removable-media loader path `EFI/boot/bootriscv64.efi`. The checked
evidence matrix records the Debian package/wiki references that establish
that contract.

`make qemu-boot ARCH=<arch>` opens an interactive GNOME desktop window for
every arch via `scripts/boot-qemu.sh`. riscv64 reaches GUI parity with
amd64/arm64 by adding `-device virtio-gpu-pci` plus USB input to the
`qemu-system-riscv64 -M virt` invocation (riscv64 `virt` has no default
GPU). Headless, fail-closed boot-marker evidence for riscv64 is a separate
path: `scripts/qemu_virt_boot_riscv64.sh` (driven by
`scripts/qemu_virt_smoke.py`), which runs `-nographic` and emits the
`eliza.os.linux.qemu_virt_boot.v1` evidence JSON.

## Profiles

`ELIZAOS_PROFILE` selects a hardening profile:

- `default` — plain Debian live desktop with the elizaOS app as the home
  surface.
- `secure` — elizaOS hardening profile: Tor routing, AppArmor enforcement,
  MAC randomization, amnesic tmpfs home, and hardening sysctls. Works on
  all arches. Built entirely from standard Debian privacy packages and
  elizaOS-authored chroot hooks — not derived from any third-party live-OS.
  The overlay is composed in by `build.sh` from `config/profiles/secure/`;
  see `config/profiles/secure/README.md`.

## Build

The only host requirement is Docker.

```sh
make build ARCH=amd64                       # x86_64 ISO
make build ARCH=arm64                        # arm64 ISO
make build ARCH=riscv64                       # riscv64 ISO
make build ARCH=amd64 PROFILE=secure          # hardened build
make riscv64-agent-runtime-smoke               # preflight staged riscv64 runtime + agent bundle
make qemu-boot ARCH=riscv64                    # boot newest ISO in QEMU
make brand-assets                              # regenerate PNG branding from SVG
make lint                                      # static smoke checks
make clean                                     # remove out/ + live-build state
```

Real agent images require per-arch artifacts under
`artifacts/<arch>/`. For riscv64, consume the shared
`bun-linux-riscv64-musl.zip` produced by
`packages/app-core/scripts/bun-riscv64/run-build.sh` and stage it with the
Debian wrapper plus the matching musl runtime:

```sh
make -C packages/os/linux/elizaos stage-agent-artifacts ARCH=riscv64
make -C packages/os/linux/elizaos riscv64-agent-runtime-smoke
```

Until the native riscv64 Bun port is current and provenance-clean, the Debian
image can be staged in Node mode. This installs no Bun artifact; the live image
must install Debian `nodejs` and run the Node-shebang `agent-bundle.js`:

```sh
make -C packages/os/linux/elizaos stage-agent-artifacts ARCH=riscv64 RISCV64_RUNTIME=node
make -C packages/os/linux/elizaos riscv64-agent-runtime-smoke
```

The runtime smoke is a pre-ISO qemu-user/static artifact check. It must pass
before a riscv64 image can be promoted; `bun --version` alone is not sufficient
because the current Bun artifact can print a version while failing on the
staged agent entrypoint. The archived failing Bun evidence is
`evidence/riscv64_agent_runtime_smoke_20260523_script_entrypoint.json`: Bun can
run `--version` and `-e`, but fails script-file entrypoints before it can load
`agent-bundle.js`. The current `evidence/riscv64_agent_runtime_smoke.json`
records the Node-mode staged artifact check; it is not full ISO boot evidence.

GUI/kiosk payload checks are per-arch and fail closed until an ISO is recorded
in `evidence/multiarch_boot_matrix.json`:

```sh
make -C packages/os/linux/elizaos riscv64-gui-kiosk-iso-check
make -C packages/os/linux/elizaos arm64-gui-kiosk-iso-check
```

The current riscv64 report passes as a static squashfs payload check. The arm64
report is intentionally blocked until a real arm64 ISO and boot evidence are
produced.

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

## Chip/AP evidence

`chip-boot-manifest.json` is the chip-objective manifest for generated Eliza
AP or chip-emulator boot evidence. It deliberately does not reuse qemu-virt
evidence. The runnable capture skeleton is:

```sh
scripts/capture-generated-ap-chip-evidence.sh plan
ELIZA_GENERATED_AP_CHIP_BOOT_CMD='<real generated-AP boot command>' \
  scripts/capture-generated-ap-chip-evidence.sh run
```

When generated-AP runtime is usable, the boot command must print the real
serial transcript. If agent/API/TUI probes are collected by a separate command,
set `ELIZA_GENERATED_AP_CHIP_AGENT_CMD`; otherwise the boot transcript must
contain those markers too. To validate pre-captured real transcripts directly:

```sh
scripts/capture-chip-boot-evidence.py \
  --boot-transcript /path/to/generated-ap-serial.log \
  --agent-transcript /path/to/generated-ap-agent-health.log
```

The helper writes `evidence/generated_eliza_ap_boot.json` and
`evidence/generated_eliza_ap_agent_live.json` only when the transcript contains
the required generated-AP SBI handoff, Linux, elizaOS first-boot,
agent-health, and terminal TUI markers.

## Status

This is the active, canonical Linux build. The build pipeline, multi-arch
config, branding overlay, `secure` hardening profile, and release-manifest
gate are in the tree. The checked-in riscv64 boot row is promoted from
`evidence/qemu_virt_boot.json`, whose matching transcript and ISO artifact are
`evidence/qemu_virt_boot_20260524T030430Z.transcript.log` and
`out/elizaos-linux-riscv64-default-20260524T030430Z.iso`; that run proves
qemu-virt EDK2/OpenSBI -> GRUB EFI -> Linux plus local curl health,
agent-ready, and terminal TUI markers. arm64 still needs produced ISO evidence
before full multi-arch release promotion. See
`packages/os/CLAUDE.md` for the distribution-channel and promotion policy.

## License

Debian/live-build components: GPL-3.0-or-later. The `secure` profile is
assembled from standard Debian privacy packages plus elizaOS-authored
hooks and is not derived from any third-party live-OS. elizaOS additions
are Apache-2.0 where separable, dual-licensed where required.
