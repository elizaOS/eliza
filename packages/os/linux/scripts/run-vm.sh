#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 NubsCarson and contributors
#
# Launch usbeliza in QEMU with sane defaults that match a modern host display.
#
# Why: virtio-vga negotiates resolution to the QEMU GTK window size, so opening
# the VM in a small letterboxed window made the chat box feel cramped on a
# 4K laptop. This script picks the right window mode (full-screen by default,
# windowed with --windowed), pins virtio-vga at 2560x1440 (sway target res),
# wires SSH on :2223, and tears down any stale QEMU before booting.
#
# Usage:
#   scripts/run-vm.sh                              # newest ISO, full-screen
#   scripts/run-vm.sh out/usbeliza-v13-final-amd64.iso
#   scripts/run-vm.sh --windowed                   # 1920x1080 GTK window
#   scripts/run-vm.sh --ssh-port 2233              # custom SSH forward
#   scripts/run-vm.sh --mem 12G --smp 8            # bump host resources

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

FULLSCREEN=true
ISO=""
SSH_PORT=2223
MEM="8G"
SMP=6

RES_OVERRIDE=""

while (( $# )); do
    case "$1" in
        --windowed) FULLSCREEN=false; shift ;;
        --fullscreen) FULLSCREEN=true; shift ;;
        --resolution) RES_OVERRIDE="$2"; shift 2 ;;
        --ssh-port) SSH_PORT="$2"; shift 2 ;;
        --mem) MEM="$2"; shift 2 ;;
        --smp) SMP="$2"; shift 2 ;;
        -h|--help)
            sed -n '1,/^set -euo/p' "$0" | head -20
            exit 0
            ;;
        *) ISO="$1"; shift ;;
    esac
done

if [[ -z "$ISO" ]]; then
    ISO="$(ls -t out/usbeliza-v*-final-amd64.iso 2>/dev/null | head -1 || true)"
fi
if [[ -z "$ISO" || ! -f "$ISO" ]]; then
    echo "ERROR: no ISO found. Pass a path or run \`just iso-build\` first." >&2
    exit 1
fi

# Kill any leftover QEMU so we don't fight over the SSH port.
if pgrep -f "qemu-system-x86_64" >/dev/null 2>&1; then
    echo "==> Killing stale QEMU"
    sudo pkill -9 -f "qemu-system-x86_64" || true
    sleep 1
fi

# Inner resolution. Fullscreen mode opens covering the primary monitor;
# virtio-vga renegotiates to that real size. Windowed mode is tricky:
# QEMU GTK opens at the virtio-vga reported xres/yres, but on some
# Wayland/GTK theme combos that initial size gets clamped to ~1100x800.
# Default windowed to 1920x1080 — a known-good GTK window size that
# fits on every modern laptop. Use --resolution WxH to override.
if [[ "$FULLSCREEN" == true ]]; then
    XRES=2560
    YRES=1440
else
    XRES=1920
    YRES=1080
fi
# Explicit --resolution WxH wins.
if [[ -n "$RES_OVERRIDE" ]]; then
    XRES="${RES_OVERRIDE%x*}"
    YRES="${RES_OVERRIDE#*x}"
fi

DISPLAY_ARGS=()
if [[ "$FULLSCREEN" == true ]]; then
    # full-screen=on covers the primary monitor. Escape with Ctrl+Alt+G to
    # release the cursor + use the host shell; close with Ctrl+Alt+F4 or the
    # window's titlebar after toggling out of full-screen.
    DISPLAY_ARGS+=(-display "gtk,full-screen=on,zoom-to-fit=on,grab-on-hover=on,show-cursor=on")
else
    # Windowed mode — opens at the virtio-vga reported size. zoom-to-fit
    # rescales content as the user drags the window.
    DISPLAY_ARGS+=(-display "gtk,zoom-to-fit=on,grab-on-hover=on,show-cursor=on")
fi

echo "==> usbeliza VM"
echo "    ISO:          $ISO"
echo "    Mode:         $([[ "$FULLSCREEN" == true ]] && echo full-screen || echo windowed)"
echo "    Inner res:    ${XRES}x${YRES}"
echo "    Memory:       $MEM"
echo "    CPU cores:    $SMP"
echo "    SSH forward:  127.0.0.1:$SSH_PORT -> guest :22"
echo "    Key:          vm/.ssh/usbeliza_dev_ed25519"
echo
echo "==> Boot takes ~90s. Press Ctrl+Alt+G to release mouse capture."
echo

exec qemu-system-x86_64 \
    -enable-kvm \
    -cpu host \
    -m "$MEM" \
    -smp "$SMP" \
    -cdrom "$ISO" \
    -boot d \
    -netdev "user,id=net0,hostfwd=tcp::${SSH_PORT}-:22" \
    -device virtio-net-pci,netdev=net0 \
    -vga none \
    -device "virtio-vga,xres=${XRES},yres=${YRES}" \
    -device virtio-keyboard-pci \
    -device virtio-tablet-pci \
    -audiodev "pa,id=snd0" \
    -device intel-hda \
    -device "hda-duplex,audiodev=snd0" \
    "${DISPLAY_ARGS[@]}" \
    -name "usbeliza"
