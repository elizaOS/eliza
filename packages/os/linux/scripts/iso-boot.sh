#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 NubsCarson and contributors
#
# Pick the newest ISO under out/ (or live-build/) and boot it in QEMU
# with a 1920×1080 GTK window, SSH forwarded to localhost:2223, and
# virtio-keyboard/tablet wired up so the guest gets real input.
#
# Extracted from a Justfile recipe because just 1.50's `bash -uc` doesn't
# substitute `$$(...)` the way the recipe expected, leaving the literal
# `$$` in the command line bash received. A bash script doesn't have
# the substitution layer in the middle.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

iso="$(ls -t out/usbeliza-v*-amd64.iso live-build/*.iso 2>/dev/null | head -1 || true)"
if [ -z "$iso" ]; then
    echo "no ISO; run 'just iso-build' first" >&2
    exit 1
fi

echo "==> booting $iso in QEMU (1920x1080, SSH on 2223)"
echo "    Ctrl+Alt+G to release pointer grab back to host"
echo

exec qemu-system-x86_64 \
    -enable-kvm -cpu host -m 6G -smp 4 \
    -cdrom "$iso" \
    -boot d \
    -netdev user,id=net0,hostfwd=tcp::2223-:22 \
    -device virtio-net-pci,netdev=net0 \
    -vga none \
    -device virtio-vga,xres=1920,yres=1080 \
    -display gtk,zoom-to-fit=on,grab-on-hover=on \
    -device virtio-keyboard-pci \
    -device virtio-tablet-pci
