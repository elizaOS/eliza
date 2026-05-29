# elizaOS Live Session Memory

Last updated: 2026-05-22.

This is the short handoff file for context resets. The authoritative status
details live in [`current-status.md`](./current-status.md).

## Latest validated artifacts

```text
out/binary.iso
sha256 0738eaf5291263de43d5c7cb326ca69bc011bcbd8ddefafe03e023db6310ced9
size   3.3G

out/binary.img
sha256 ff9f5dc15729164bb115ae73cc4d2d75e43f0b45596227149469971300ce123c
size   12G
```

## What is proven

- `bun run --cwd packages/app-core/platforms/electrobun build` passed.
- `just elizaos-app` staged the rebuilt app into the live-build overlay.
- `node scripts/prepare-elizaos-app-overlay.mjs --check` passed.
- `ELIZAOS_STATIC_SOURCE_ONLY=1 ./scripts/static-smoke.sh` passed.
- `./scripts/runtime-api-smoke.sh` passed.
- `./build.sh binary` rebuilt the ISO with 4 CPUs.
- `tails/auto/scripts/create-usb-image-from-iso out/binary.iso -d out`
  created the writable USB image.
- The USB image has visible FAT label `ELIZAOS`, installed syslinux, a moved
  backup GPT header at the physical image end, and checksum verification.
- QEMU boot from `out/binary.img` as USB mass storage reached the elizaOS
  greeter.
- `Start elizaOS` reached the normal GNOME desktop.
- The bundled elizaOS app auto-launched.
- App close now minimizes to the GNOME task list and restores from
  `[elizaOS]`.
- Persistent Storage creation from the final USB-image VM reaches the unlocked
  feature-toggle screen.

## Still not proven

- Physical USB flash/readback for the exact `out/binary.img`.
- Physical hardware boot.
- Persistent Storage create/unlock/reboot/unlock on physical hardware.
- Privacy Mode behavior for embedded browser/OAuth/external web surfaces.
- Production release signing, app/runtime updater, model catalog, SBOM, and
  provenance.

## Development rules

- Work in `packages/os/linux/` for this distro path.
- Do not commit `out/`, `tails/chroot/`, `tails/binary/`, qcow2 overlays,
  or `packages/app-core/platforms/electrobun/.generated/brand-config.json`.
- Keep user-facing branding as elizaOS. Internal `tails` and `/opt/elizaos`
  names are preserved where they are upstream plumbing or app-runtime
  contracts.
- For fast source checks:

```bash
node scripts/prepare-elizaos-app-overlay.mjs --check
ELIZAOS_STATIC_SOURCE_ONLY=1 ./scripts/static-smoke.sh
./scripts/runtime-api-smoke.sh
```

- For the persistence-compatible USB artifact:

```bash
./build.sh binary
tails/auto/scripts/create-usb-image-from-iso out/binary.iso -d out
truncate -s 12G out/binary.img
sgdisk --move-second-header out/binary.img
sgdisk --verify out/binary.img
sha256sum out/binary.iso out/binary.img > out/SHA256SUMS
sha256sum -c out/SHA256SUMS
```
