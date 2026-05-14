# usbeliza live-build (Phase 1 ISO)

Production-grade Debian live ISO that boots **identically** in QEMU and from
a real USB stick — same kernel, same initramfs, same boot flow Tails uses.

## Architecture

`auto/config` calls `lb config` with the flags that matter:

- `--linux-flavours amd64` → **full Debian kernel**, not the cloud kernel.
  Ships `virtio-gpu.ko` + `bochsdrm.ko` + the rest of the DRM stack, so
  `/dev/dri/card0` actually exists at boot. (The whole reason Phase 0's
  cloud-qcow2 GUI demo doesn't render.)
- `--initramfs live-boot` → live-boot's initramfs scripts mount
  `/lib/live/mount/medium/live/filesystem.squashfs` read-only and overlay a
  tmpfs (or, in Phase 1 persistence, a LUKS-decrypted sdX3 partition).
- `--bootappend-live live-config.username=eliza …` → live-config consumes
  this at boot to create the eliza user, set hostname, locale, keyboard.
- `--bootloaders grub-pc,grub-efi` → BIOS + UEFI, isohybrid (works via dd).
- `--archive-areas main contrib non-free non-free-firmware` → includes
  WiFi firmware blobs so the USB boots on real laptops.

Reference: Tails' `auto/config` for the same flag pattern, minus Tor,
IUK, GNOME, onion-grater.

## Layout

```
live-build/
├── auto/
│   ├── config    # `lb config` invocation (build flags)
│   ├── build     # `lb build` invocation (needs root)
│   └── clean     # `lb clean` invocation
├── config/
│   ├── package-lists/
│   │   └── usbeliza.list.chroot   # apt packages (mirrors mmdebstrap.recipe)
│   ├── chroot_local-hooks/
│   │   ├── 01-usbeliza-systemd    # mask wait-online, enable our units
│   │   └── 02-usbeliza-runtimes   # install Bun + Ollama + pull model
│   └── chroot_local-includes/     # files dropped into the chroot
│       ├── etc/systemd/system/*.service
│       ├── etc/sway/config
│       ├── etc/default/grub.d/usbeliza.cfg
│       ├── etc/issue
│       ├── usr/share/plymouth/themes/usbeliza/
│       └── usr/local/bin/usbeliza-input-listener
└── (build outputs: live-image-amd64.hybrid.iso, etc — gitignored)
```

## Build

```
just iso-build           # builds live-image-amd64.hybrid.iso (~3 GB, ~15 min first time)
just iso-boot            # boot it in QEMU/KVM
just iso-usb /dev/sdX    # dd it to a USB stick
just iso-clean           # wipe the working dir for a clean rebuild
```

## Production-grade

- All build inputs version-pinned via APT/Debian's normal package system.
- No cloud-image hacks. The ISO is the same as a normal Debian live ISO
  with our overlay + chroot hooks layered on.
- Reproducible builds get gated on `SOURCE_DATE_EPOCH` per the live-build
  conventions (Tails does this; we don't yet — TODO for Phase 1.5).

## Phase 1 follow-ups

- LUKS persistence on `sdX3` (Tails' `tails-persistence-setup` adapted under
  `third-party/tails/`, GPL-3.0-or-later).
- NetworkManager wrapper for the `connect to wifi <SSID>` chat command.
- Custom GRUB theme background (PNG).
- Reproducible build attestation via SOURCE_DATE_EPOCH.
