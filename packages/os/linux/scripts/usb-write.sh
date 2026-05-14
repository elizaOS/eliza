#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 NubsCarson and contributors
#
# scripts/usb-write.sh — safety-guarded USB writer for the usbeliza live ISO.
#
# Usage:
#   scripts/usb-write.sh /dev/sdX               # write newest out/usbeliza-v*.iso
#   scripts/usb-write.sh /dev/sdX <iso>         # write a specific ISO
#
# Safety rails (all enforced before any writes):
#   * Refuses to write to a non-removable device (/sys/block/<dev>/removable != 1)
#   * Refuses to write to a device that's currently mounted anywhere
#   * Refuses /dev/sda — that's almost always the host root disk
#   * Prints the device's size, model, current partition table BEFORE
#     asking for confirmation
#   * Requires the user to type the full device path back ("/dev/sdb")
#     to confirm — defeats fat-finger / mis-paste
#   * Reads sha256sum if present alongside the ISO and verifies first
#
# After write, runs `sync` + waits for kernel writeback to flush before
# returning. Uses `pv` for a progress bar if installed, else dd with
# status=progress. Mirrors the safety posture Tails' Universal USB Installer
# documents, just in shell.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

red()    { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
bold()   { printf '\033[1m%s\033[0m\n' "$*"; }

DEVICE="${1:-}"
ISO="${2:-}"

if [[ -z "$DEVICE" ]]; then
    red "Usage: $0 /dev/sdX [iso-path]"
    red ""
    red "Found these likely USB candidates (run lsblk for full list):"
    for d in /sys/block/sd*; do
        [[ -e "$d/removable" ]] || continue
        rm="$(cat "$d/removable" 2>/dev/null)"
        [[ "$rm" == "1" ]] || continue
        name="$(basename "$d")"
        size="$(cat "$d/size" 2>/dev/null)"
        bytes=$((size * 512))
        gib=$((bytes / 1024 / 1024 / 1024))
        model="$(cat "$d/device/model" 2>/dev/null || echo unknown)"
        red "  /dev/$name  (${gib} GiB, $model)"
    done
    exit 2
fi

if [[ -z "$ISO" ]]; then
    ISO="$(ls -t out/usbeliza-v*-final-amd64.iso 2>/dev/null | head -1 || true)"
    if [[ -z "$ISO" ]]; then
        red "No ISO under out/. Pass a path or run 'just iso-build'."
        exit 2
    fi
fi

# --- Sanity: ISO exists and is bootable ---
if [[ ! -f "$ISO" ]]; then
    red "ISO not found: $ISO"
    exit 2
fi
file_out="$(file -b "$ISO")"
if ! grep -qi "ISO 9660\|bootable" <<< "$file_out"; then
    red "File does not look like a bootable ISO:"
    red "  $file_out"
    exit 2
fi
iso_bytes="$(stat -c%s "$ISO")"
iso_mib=$((iso_bytes / 1024 / 1024))

# --- Optional sha256 verify ---
if [[ -f "${ISO}.sha256" ]]; then
    yellow "Verifying ${ISO}.sha256..."
    pushd "$(dirname "$ISO")" >/dev/null
    sha256sum -c "$(basename "$ISO").sha256" >/dev/null
    popd >/dev/null
    green "  sha256 ok"
fi

# --- Sanity: device exists and is a block device ---
if [[ ! -b "$DEVICE" ]]; then
    red "Not a block device: $DEVICE"
    exit 2
fi
dev_name="$(basename "$DEVICE")"
sys_dev="/sys/block/$dev_name"
if [[ ! -d "$sys_dev" ]]; then
    red "Device $DEVICE has no /sys/block entry — refusing to write."
    exit 2
fi

# --- HARD GUARD: refuse the host root disk ---
if [[ "$dev_name" == "sda" || "$dev_name" == "nvme0n1" ]]; then
    red "REFUSING to write to $DEVICE — that's almost always the host disk."
    red "If you're really sure this is a USB, write the ISO with dd by hand."
    exit 3
fi

# --- HARD GUARD: removable=1 ---
removable="$(cat "$sys_dev/removable" 2>/dev/null || echo 0)"
if [[ "$removable" != "1" ]]; then
    red "$DEVICE reports removable=$removable — refusing to write."
    red "USB sticks report removable=1. Internal SSDs report 0."
    exit 3
fi

# --- HARD GUARD: nothing mounted from this device ---
if mount | grep -q " on .* type .* (.*)$" && lsblk -nlpo NAME,MOUNTPOINT "$DEVICE" 2>/dev/null | grep -qE "^${DEVICE}([0-9]+)?\s+/"; then
    red "Partitions on $DEVICE are currently mounted:"
    lsblk -nlpo NAME,MOUNTPOINT "$DEVICE" | grep -v '^$'
    red "Unmount them first: sudo umount $DEVICE*"
    exit 3
fi

# --- Print device facts ---
dev_size_blocks="$(cat "$sys_dev/size")"
dev_bytes=$((dev_size_blocks * 512))
dev_gib=$((dev_bytes / 1024 / 1024 / 1024))
dev_model="$(cat "$sys_dev/device/model" 2>/dev/null | tr -s ' ' || echo unknown)"
dev_vendor="$(cat "$sys_dev/device/vendor" 2>/dev/null | tr -s ' ' || echo unknown)"

echo
bold "About to write usbeliza live ISO to a USB stick"
echo
echo "  ISO:    $ISO  (${iso_mib} MiB)"
echo "  Target: $DEVICE"
echo "  Size:   ${dev_gib} GiB"
echo "  Vendor: $dev_vendor"
echo "  Model:  $dev_model"
echo
yellow "ALL DATA ON $DEVICE WILL BE DESTROYED."
echo
echo "To confirm, type the device path back exactly:"
read -r -p "  ('$DEVICE' or anything else to abort): " CONFIRM
if [[ "$CONFIRM" != "$DEVICE" ]]; then
    red "Aborted (didn't get $DEVICE back)."
    exit 1
fi

# --- Write ---
echo
yellow "Writing — do NOT pull the USB stick until 'sync' completes."
echo

if command -v pv >/dev/null 2>&1; then
    pv -s "$iso_bytes" -- "$ISO" | sudo dd of="$DEVICE" bs=4M oflag=direct conv=fsync
else
    sudo dd if="$ISO" of="$DEVICE" bs=4M oflag=direct conv=fsync status=progress
fi

echo
yellow "Syncing kernel writeback (this is the slow part — usually 30-90s)..."
sync
# Ask the kernel to drop its caches as a belt-and-braces flush. Failure
# (e.g. running unprivileged on a hardened kernel) is non-fatal.
sudo sh -c 'echo 3 > /proc/sys/vm/drop_caches' 2>/dev/null || true
sync
echo
green "Done. You can safely remove the USB stick."
echo "Reboot the target machine, hold the boot-menu key (typically F12, F10,"
echo "Esc, or the brand-specific key), pick the USB, and Eliza will greet you."
