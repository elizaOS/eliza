#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 NubsCarson and contributors
#
# Aggressive clean for live-build/. Runs `lb clean` first (via auto/clean),
# then forcibly unmounts any binds that auto/clean missed and removes the
# stage/lock artifacts that block a rerun. We've hit this 5+ times when a
# build was killed mid-stage and `lb config` then refused to proceed.
#
# Idempotent: running twice with nothing to clean is not an error.

set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo/live-build"

echo "==> running lb clean (via auto/clean)"
sudo auto/clean || true

echo "==> unmounting any leftover chroot binds"
for sub in dev/pts proc sys run var/run var/lib/dpkg; do
    target="chroot/$sub"
    if mountpoint -q "$target" 2>/dev/null; then
        echo "    umount -lf $target"
        sudo umount -lf "$target" || true
    fi
done
# Also catch any straggler nested mounts (e.g. binfmt_misc under proc).
while read -r m; do
    case "$m" in
        "$(realpath chroot 2>/dev/null)"*|chroot/*) :;;
        *) continue;;
    esac
    echo "    umount -lf $m"
    sudo umount -lf "$m" || true
done < <(awk '{print $2}' /proc/mounts | grep -F "$(realpath chroot 2>/dev/null || echo /__nope__)" || true)

echo "==> removing stage / lock artifacts"
sudo rm -rf .build .lock chroot.lock 2>/dev/null || true
sudo rm -f \
    chroot.files chroot.packages.install chroot.packages.live \
    live-image-amd64.files live-image-amd64.packages \
    live-image-amd64.hybrid.iso \
    binary.modified_timestamps \
    2>/dev/null || true

echo "==> ok: live-build/ is reset (chroot dir kept; remove manually if needed)"
