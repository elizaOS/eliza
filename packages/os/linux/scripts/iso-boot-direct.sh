#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 NubsCarson and contributors
#
# Boot the latest ISO in QEMU with -kernel/-initrd/-append extracted from
# the ISO. The advantage over -cdrom is that we can override the kernel
# cmdline at the QEMU layer — useful for diagnostics like adding
# `console=ttyS0` or `systemd.debug-shell=1` without rebuilding.
#
# The ISO is still attached as a virtual CD so live-boot can find the
# squashfs at /live/filesystem.squashfs.
#
# Extracts to /var/tmp/usbeliza-isoboot/ (NOT /tmp — that's a 16G tmpfs
# we keep filling up). Reuses extracted kernel/initrd if the ISO mtime
# hasn't changed.

set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"

iso="$(ls -t out/usbeliza-v*-amd64.iso live-build/*.iso 2>/dev/null | head -1)"
if [ -z "$iso" ]; then
    echo "no ISO; run 'just iso-build' first" >&2
    exit 1
fi

work=/var/tmp/usbeliza-isoboot
mkdir -p "$work"

stamp_old="$(cat "$work/.iso-stamp" 2>/dev/null || true)"
stamp_new="$(stat -c '%n:%Y' "$iso")"

if [ "$stamp_old" != "$stamp_new" ] || [ ! -s "$work/vmlinuz" ] || [ ! -s "$work/initrd" ]; then
    echo "==> extracting kernel + initrd from $iso"
    mnt=/var/tmp/usbeliza-isoboot-mnt
    mkdir -p "$mnt"
    sudo mount -o loop,ro "$iso" "$mnt"
    trap 'sudo umount "$mnt" 2>/dev/null || true' EXIT

    # Tails / live-build layout: /live/vmlinuz, /live/initrd.img.
    kernel=""
    initrd=""
    for cand in /live/vmlinuz /live/vmlinuz-* /boot/vmlinuz /boot/vmlinuz-*; do
        if [ -s "$mnt$cand" ]; then kernel="$mnt$cand"; break; fi
    done
    for cand in /live/initrd.img /live/initrd.img-* /boot/initrd.img /boot/initrd.img-*; do
        if [ -s "$mnt$cand" ]; then initrd="$mnt$cand"; break; fi
    done
    if [ -z "$kernel" ] || [ -z "$initrd" ]; then
        echo "could not find kernel/initrd inside $iso" >&2
        exit 1
    fi

    sudo install -m 0644 "$kernel" "$work/vmlinuz"
    sudo install -m 0644 "$initrd" "$work/initrd"
    sudo chown "$(id -u):$(id -g)" "$work/vmlinuz" "$work/initrd"
    echo "$stamp_new" > "$work/.iso-stamp"
    sudo umount "$mnt"
    trap - EXIT
else
    echo "==> reusing cached kernel + initrd at $work"
fi

# Default cmdline matches live-build/auto/config's bootappend-live. Append
# anything passed on the command line, e.g.:
#   just iso-boot-direct console=ttyS0 systemd.log_level=debug
cmdline="boot=live components quiet splash noeject findiso=/live/usbeliza.iso"
extra="$*"
if [ -n "$extra" ]; then
    cmdline="$cmdline $extra"
fi
echo "==> kernel cmdline: $cmdline"
echo "==> booting $iso (direct-kernel)"

exec qemu-system-x86_64 \
    -enable-kvm -cpu host -m 6G -smp 4 \
    -kernel "$work/vmlinuz" \
    -initrd "$work/initrd" \
    -append "$cmdline" \
    -drive file="$iso",media=cdrom,readonly=on \
    -boot d \
    -netdev user,id=net0,hostfwd=tcp::2222-:22 \
    -device virtio-net-pci,netdev=net0 \
    -vga none \
    -device virtio-vga,xres=1920,yres=1080 \
    -display gtk,zoom-to-fit=on,grab-on-hover=on \
    -device virtio-keyboard-pci \
    -device virtio-tablet-pci
