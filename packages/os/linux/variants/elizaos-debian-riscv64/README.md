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

The Dockerfile, build orchestrator, `auto/config`, package lists,
chroot/binary hooks, extlinux fallback, and manifest template form the
RISC-V 64 live-build pipeline. A board-bring-up engineer can run the
builder container and expect `lb build` to produce a bootable RISC-V 64
live ISO suitable for `qemu-system-riscv64 -M virt`.

The artifact itself has **not** been produced from this checkout yet.
Running `lb build` pulls multi-GB from Debian mirrors and takes 30+
minutes, so CI and release hosts should run it in a dedicated builder.
The template fields in `manifest.json.template` stay unresolved until a
real build replaces them.

What works today:

- `docker build -t elizaos-debian-riscv64-builder .` produces a builder
  image with `live-build`, `debootstrap`, `qemu-user-static`,
  `grub-efi-riscv64-bin`, `u-boot-menu`, and the riscv64 multiarch
  toolchain installed.
- `lb config` (step 1/5 of `build.sh`) runs end-to-end against the
  Wave-4 `auto/config`.
- `lb build` (step 2/5) is no longer gated; it is the real call.
- Steps 3-5 verify the artifact exists, is >= 200 MiB, mounts via
  `iso-info` / `isoinfo`, sha256s/sizes the artifact, and emits a
  manifest fragment that JSON-parses against
  [`packages/os/release/schema/elizaos-os-release-manifest.schema.json`](../../../release/schema/elizaos-os-release-manifest.schema.json).
- The USB installer dry-run backend
  ([`dry-run-backend.ts`](../../../usb-installer/src/backend/dry-run-backend.ts))
  carries a `planned` riscv64 image entry so UI flows can render the
  variant without it needing to be downloadable.

What does **not** work yet:

- No published artifact exists. The template URL in
  `manifest.json.template` and `DEFAULT_ELIZAOS_IMAGES` resolves to
  nothing.
- No board-bring-up evidence is collected yet; the `evidence[]` array
  in the manifest is all `status: "missing"` by design.
- The chroot hook at `config/hooks/normal/0010-elizaos-agent.hook.chroot`
  installs a real agent payload from `/opt/elizaos-artifacts/` and
  verifies the shared `bun-linux-riscv64-musl.zip` SHA-256 before the
  image can finish building.

## Agent artifact contract

The live-build chroot must contain these files before
`0010-elizaos-agent.hook.chroot` runs:

```text
/opt/elizaos-artifacts/
├── bun-linux-riscv64-musl.zip
├── bun-linux-riscv64-musl.zip.sha256
└── elizaos-agent-riscv64/
    └── elizaos
```

`bun-linux-riscv64-musl.zip` is the same artifact described by
`packages/app-core/scripts/bun-riscv64/bun-version.json` and consumed by
Android when `ELIZA_BUN_RISCV64_URL` is set. Its internal Bun binary
must be at `bun-linux-riscv64-musl/bun`. The SHA-256 file contains the
expected digest for the zip. The `elizaos` binary must be executable and
must support:

```sh
/opt/elizaos/bin/elizaos start --headless --port=31337
```

The hook fails the build if any artifact is missing, if the digest does
not match, or if the Bun payload does not unpack to an executable
`bun-linux-riscv64-musl/bun`.

## Running the build

The live-build run takes 30+ minutes and downloads multi-GB from
Debian mirrors. Do not invoke it from an interactive sub-agent; run
it on the builder host or in CI.

```sh
cd packages/os/linux/variants/elizaos-debian-riscv64/
docker build -t elizaos-debian-riscv64-builder .
docker run --rm --privileged \
    -v "$(pwd):/build" -v "$(pwd)/out:/out" \
    elizaos-debian-riscv64-builder
```

Outputs land in `out/`:

- `elizaos-debian-riscv64-<ts>.iso` — the bootable live image.
- `elizaos-debian-riscv64-<ts>.manifest.json` — the filled-in release
  manifest fragment (sha256, size, build_ts, arch, kernel_flavour).

## Relationship to chip-team bring-up

This variant is the **userspace** side of riscv64 support. The
**firmware / boot / kernel** side lives under the chip submodule:

- [`packages/chip/docs/android/riscv-bringup.md`](../../../../chip/docs/android/riscv-bringup.md)
  — QEMU `virt`, Renode, TH1520 board, and `e1_soc` RTL bring-up
  recipes. Read this first when wiring up a real board.
- [`packages/chip/docs/toolchain/riscv64-cross-host.md`](../../../../chip/docs/toolchain/riscv64-cross-host.md)
  — the cross-toolchain conventions this variant assumes on the
  builder host.
- [`packages/chip/docs/sw/opensbi/README.md`](../../../../chip/docs/sw/opensbi/README.md)
  — OpenSBI fw_dynamic handoff this ISO depends on at the SBI layer.
- [`packages/chip/docs/sw/u-boot/README.md`](../../../../chip/docs/sw/u-boot/README.md)
  — U-Boot distroboot path the `extlinux.conf` fallback in this
  variant targets.
- [`packages/chip/docs/sw/linux/README.md`](../../../../chip/docs/sw/linux/README.md)
  — chip-side Linux kernel notes; this variant pairs the Debian
  `linux-image-riscv64` package against the same `e1_platform_contract`
  the chip team consumes.

Firmware blobs and kernel binaries are **not** committed to this
directory. They are sourced from the chip submodule at runtime so a
single SoC firmware revision tracks both Android and Linux variants.

## Files

```
elizaos-debian-riscv64/
├── Dockerfile                builder image (debian:trixie-slim + live-build + riscv64 boot tools)
├── build.sh                  orchestrator: lb config → lb build → verify → checksum → manifest
├── auto/config               live-build config (architecture, kernel flavour, bootloader, archive areas)
├── config/
│   ├── package-lists/
│   │   └── elizaos.list.chroot               base + linux-image-riscv64 + grub + nodejs + sqlite + ssh
│   ├── hooks/normal/
│   │   ├── 0010-elizaos-agent.hook.chroot    verified agent + Bun payload install, ssh hardening
│   │   └── 0020-grub-efi-riscv64.hook.binary builds BOOTRISCV64.EFI + grub.cfg
│   └── includes.binary/extlinux/extlinux.conf  U-Boot distroboot fallback
├── manifest.json.template    artifact fragment that build.sh fills in
└── README.md                 this file
```

## Remaining work

1. Run `lb build` on the builder host or in CI; capture the ISO,
   manifest fragment, and qemu-virt boot transcript.
2. Wire `firmware/` into the chroot from the chip submodule when a
   board target needs blobs (do not commit blobs here).
3. Collect bring-up evidence under
   `packages/chip/docs/evidence/linux/` and flip the corresponding
   `evidence[].status` from `missing` to `collected` in the emitted
   manifest fragment.
4. Capture `agent-health-live` evidence with `elizaos-agent.service`
   active and `/api/health` responding on the boot target.
5. Once an artifact actually publishes, update the matching entry in
   `DEFAULT_ELIZAOS_IMAGES` (real URL, real sha256, real size) and
   move its release status from `planned` to `candidate`/`available`.
