# elizaOS Debian RISC-V 64

A parallel Linux variant to [`milady-tails`](../milady-tails/), targeting
**riscv64** on **Debian Trixie**. This is the riscv64 entry the elizaOS
USB-installer pipeline and release manifest point at.

It is **not** a Tails fork. There is no amnesia/Tor/persistence plumbing
in this variant — only a plain Debian live system that boots on riscv64
hardware (and under QEMU `virt`) with the elizaOS userland on top. The
two variants live side by side and serve different audiences:

| Variant                              | Arch    | Base               | Privacy plumbing | Audience |
|--------------------------------------|---------|--------------------|------------------|----------|
| `milady-tails`                       | x86_64  | Tails / Debian     | Yes (Tails fork) | USB-key product, full privacy mode |
| `elizaos-debian-riscv64` (this one)  | riscv64 | Debian Trixie live | No               | RISC-V hardware bring-up, dev boards |

## Status

**Wave 2B-B1: skeleton only.** The Dockerfile, build orchestrator,
auto/config, and manifest template are real — they are the same shapes
the milady-tails variant uses. The actual rootfs configuration that
makes `lb build` emit a bootable image lives in **Wave 4**.

What works today:

- `docker build -t elizaos-debian-riscv64-builder .` produces a builder
  image with `live-build`, `debootstrap`, `qemu-user-static`,
  `grub-efi-riscv64-bin` / `grub-efi-riscv64-signed`, `u-boot-menu`,
  and `extlinux` installed.
- `lb config --architecture riscv64 --linux-flavours riscv64
  --bootloader grub-efi` runs end-to-end (step 1/4 of `build.sh`).
- The manifest template is schema-valid as a fragment of
  [`packages/os/release/schema/elizaos-os-release-manifest.schema.json`](../../../release/schema/elizaos-os-release-manifest.schema.json).
- The USB installer dry-run backend
  ([`dry-run-backend.ts`](../../../usb-installer/src/backend/dry-run-backend.ts))
  carries a `planned` riscv64 image entry so UI flows can render the
  variant without it needing to be downloadable.

What does **not** work yet (Wave 4):

- `lb build` is gated behind an explicit `exit 1` in `build.sh`. The
  rootfs package list, kernel/initrd selection, greeter/agent hooks,
  and U-Boot / grub-efi-riscv64 boot menu have not been ported yet.
- No published artifact exists. The placeholder URL in
  `manifest.json.template` and `DEFAULT_ELIZAOS_IMAGES` resolves to
  nothing.
- No board-bring-up evidence is collected yet; the `evidence[]` array
  in the manifest is all `status: "missing"` by design.

## Relationship to chip-team bring-up

This variant is the **userspace** side of riscv64 support. The
**firmware / boot / kernel** side lives under the chip submodule:

- [`packages/chip/docs/android/riscv-bringup.md`](../../../../chip/docs/android/riscv-bringup.md)
  — QEMU `virt`, Renode, TH1520 board, and `e1_soc` RTL bring-up
  recipes. Read this first when wiring up a real board.
- [`packages/chip/docs/toolchain/riscv64-cross-host.md`](../../../../chip/docs/toolchain/riscv64-cross-host.md)
  — the cross-toolchain conventions this variant assumes on the
  builder host.

Firmware blobs and kernel binaries are **not** committed to this
directory. They are sourced from the chip submodule at runtime so a
single SoC firmware revision tracks both Android and Linux variants.

## Files

```
elizaos-debian-riscv64/
├── Dockerfile            builder image (debian:trixie-slim + live-build + riscv64 boot tools)
├── build.sh              orchestrator: lb config → lb build → checksum → manifest fragment
├── auto/config           live-build config (architecture, kernel flavour, bootloader)
├── manifest.json.template  artifact fragment that build.sh fills in
└── README.md             this file
```

## How to extend (Wave 4)

When Wave 4 picks this up:

1. Drop the `exit 1` gate in `build.sh` step 2/4 once `lb build` has a
   real chance of succeeding.
2. Add `config/package-lists/elizaos.list.chroot` with the elizaOS
   agent + runtime packages.
3. Add `config/hooks/` for first-boot agent initialisation and any
   greeter customisation that should diverge from upstream Debian
   live.
4. Wire `firmware/` into the chroot from the chip submodule (do not
   commit blobs here).
5. Collect bring-up evidence under
   `packages/chip/docs/evidence/linux/` and flip the corresponding
   `evidence[].status` from `missing` to `collected` in the emitted
   manifest fragment.
6. Once an artifact actually publishes, update the matching entry in
   `DEFAULT_ELIZAOS_IMAGES` (real URL, real sha256, real size) and
   move its release status from `planned` to `candidate`/`available`.
