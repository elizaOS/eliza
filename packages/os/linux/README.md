# elizaOS Linux

The accepted v1 product is a persistent Debian 13 GNOME workstation assembled
by mkosi for x86_64, arm64, and riscv64. Tails, amnesia, Tor Privacy Mode, Cage,
and the legacy live-ISO path are not release surfaces. The normative
architecture and qualification gates are documented in
[`docs/mkosi-v1-architecture.md`](./docs/mkosi-v1-architecture.md).

This directory owns the elizaOS Debian live image and its release boundary.
The canonical build is [`elizaos/`](./elizaos/): Debian trixie, GNOME, the
packaged elizaOS desktop runtime, and bootable BIOS/UEFI media.

The former vendored Tails tree and its unused build scripts have been removed.
No Tails privacy, persistence, application, or release claim is part of this
distribution.

## Product contract

- Boot a normal GNOME desktop, not a locked kiosk.
- Show an elizaOS bottom taskbar and start one packaged elizaOS app process.
- Rest as the translucent mobile chat pill; expand to the canonical shared
  mobile chat sheet; drag to the complete usable work area.
- Support text, microphone capture, always-on voice mode, local inference, and
  cloud runtime selection through the packaged application.
- Expose owner-authorized OS administration through the audited elizaOS
  capability runner. The application receives no blanket sudo shell; all root
  execution crosses that logged broker boundary.
- Pin and verify the exact `elizaOS/eliza` application artifact copied into a
  release image.
- Fail closed when application, boot, checksum, manifest, or runtime evidence
  is absent.

## Build

The host needs Docker. A Linux amd64 packaged application is also required for
the amd64 GUI image.

```bash
export ELIZAOS_ELIZA_ROOT=/path/to/eliza
export ELIZAOS_APP_ARTIFACT="$ELIZAOS_ELIZA_ROOT/packages/app-core/platforms/electrobun/build/dev-linux-x64/Eliza-dev"
just config
just build
```

The packaged runtime's `Resources/app/eliza-dist/build-info.json` commit must
equal [`elizaos/app-source.lock.json`](./elizaos/app-source.lock.json). The
builder rejects any other application bytes and records both that source commit
and a deterministic packaged-tree digest in the ISO manifest.

Debian's builder base plus the trixie main, updates, and security archives are
locked in [`elizaos/debian-snapshot.lock.json`](./elizaos/debian-snapshot.lock.json).
Before live-build runs, the builder downloads all three immutable Release files
over HTTPS and rejects any digest drift. The resulting manifest records the
snapshot serial and base-image digest.

The direct entrypoint is equivalent:

```bash
ELIZAOS_ARCH=amd64 \
ELIZAOS_PROFILE=gui \
ELIZAOS_APP_ARTIFACT=/path/to/Eliza-dev \
./build.sh build
```

Artifacts and manifests are written under `elizaos/out/`. Builds occur in a
private container work tree; a source checkout is never used as mutable
live-build state.

## Boot and verification

```bash
make -C elizaos lint
make -C elizaos qemu-boot ARCH=amd64 ISO=/absolute/path/to/image.iso
elizaos/scripts/boot-qemu.sh --arch amd64 --firmware bios /absolute/path/to/image.iso
elizaos/scripts/boot-qemu.sh --arch amd64 --firmware uefi /absolute/path/to/image.iso
```

A source-only check is not release evidence. Release acceptance requires the
current ISO to boot through both SeaBIOS and OVMF, a manually inspected GUI
capture, packaged runtime health/chat checks, PipeWire microphone evidence,
local and cloud setup evidence, and a successful capability-runner failure and
success path. Hardware support is recorded separately from QEMU proof.

## Architecture boundary

Application/framework/native-host code belongs in `elizaOS/eliza`. This
repository consumes the resulting packaged artifacts. Debian image policy,
systemd units, boot configuration, capability policy, manifests, and release
workflows belong here.

Android/AOSP images are owned by `../android/`; Linux proof does not imply
Android emulator or Pixel/Light Phone hardware proof.
