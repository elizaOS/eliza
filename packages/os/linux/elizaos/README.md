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

`PROFILE=default` is the headless Debian live image. `PROFILE=gui` composes
the kiosk/GUI overlay and makes `graphical.target -> seatd -> elizaos-kiosk`
the default boot path. `make qemu-boot ARCH=<arch>` opens an interactive GUI
window for GUI-profile ISOs via `scripts/boot-qemu.sh`. riscv64 reaches GUI
parity with amd64/arm64 by adding `-device virtio-gpu-pci` plus USB input to
the `qemu-system-riscv64 -M virt` invocation (riscv64 `virt` has no default
GPU). Headless, fail-closed boot-marker evidence for riscv64 is a separate
path: `scripts/qemu_virt_boot_riscv64.sh` (driven by
`scripts/qemu_virt_smoke.py`), which runs `-nographic` and emits the
`eliza.os.linux.qemu_virt_boot.v1` evidence JSON.

## Profiles

`ELIZAOS_PROFILE` selects a hardening profile:

- `default` — plain Debian live image with the elizaOS agent and console/TUI
  path, no GUI packages installed by default.
- `gui` — kiosk GUI overlay for the elizaOS app home surface. Installs the
  WebKitGTK/Epiphany/cage/seatd/Xorg/GNOME fallback payload and switches boot
  to `graphical.target`.
- `secure` — elizaOS hardening profile: Tor routing, AppArmor enforcement,
  MAC randomization, amnesic tmpfs home, and hardening sysctls. Works on
  all arches. Built entirely from standard Debian privacy packages and
  elizaOS-authored chroot hooks — not derived from any third-party live-OS.
  The overlay is composed in by `build.sh` from `config/profiles/secure/`;
  see `config/profiles/secure/README.md`.
- `secure-gui` — secure plus GUI overlays.

## Build paths

Two build orchestrators ship in this tree, sharing one source of truth for
the rootfs skeleton, chroot hooks, systemd units, and kiosk wiring:

- **live-build (current default; documented below).** Source-of-truth for
  release artifacts today. Multi-arch ISO via `lb config` / `lb build`.
- **mkosi (additive, in active bring-up).** See `mkosi/README.md`. Produces
  bootable `*.raw[.zst]` disk images (systemd-repart partitioned) and an
  optional hybrid `*.iso` wrap. Targets: `make mkosi-build ARCH=… PROFILE=…`,
  `make mkosi-summary`, `make mkosi-lint`. Reuses the live-build hooks
  unchanged. The live-build path stays canonical until mkosi has equivalent
  QEMU boot evidence on all three arches.

## Build

The only host requirement is Docker.

```sh
make build ARCH=amd64                       # x86_64 ISO
make build ARCH=arm64                        # arm64 ISO
make build ARCH=riscv64                       # riscv64 headless/default ISO
make build ARCH=riscv64 PROFILE=gui           # riscv64 GUI/kiosk ISO
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

GUI/kiosk payload checks are per-arch and are intended for `PROFILE=gui` ISOs.
They fail closed until a GUI ISO is recorded in
`evidence/multiarch_boot_matrix.json` or passed explicitly with `ISO=...`:

```sh
make -C packages/os/linux/elizaos riscv64-gui-kiosk-iso-check
make -C packages/os/linux/elizaos arm64-gui-kiosk-iso-check
```

The current riscv64 and arm64 GUI reports pass as static squashfs payload
checks for previously built GUI-capable ISOs. Capture GUI reference evidence
against a fresh GUI artifact such as
`out/elizaos-linux-riscv64-gui-<timestamp>.iso`; do not reuse the headless
`out/elizaos-linux-riscv64-default-20260524T030430Z.iso` matrix entry for GUI
kiosk validation.

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
The checked-in `manifest.json` is scoped to the generic qemu-virt RISC-V
release candidate backed by local ISO, transcript, and runtime-smoke evidence;
it is not generated Eliza AP, chip-emulator, phone, silicon, or physical board
boot evidence. `manifest.json.template` remains the skeleton for future
builds before evidence collection.

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
