#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 NubsCarson and contributors
#
# Show the state of an in-flight ISO build: build pid, current stage,
# chroot size, last few meaningful log lines. Run this when you're not
# sure whether the background build is alive, stuck, or finished.
#
# The grep filter strips curl's progress-bar lines (otherwise tail dumps
# 100k+ chars of "% %%%%% % %%%" from a single line containing every
# percentage tick the bun/ollama installers print).
#
# Lives as a script (not inline in the Justfile) because Just's `$$`
# escaping around nested `$(...)` and grep alternations was a recurring
# foot-gun.

set -uo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"

echo "==> processes:"
procs="$(ps -ef | grep -E 'auto/build|lb |debootstrap|mksquashfs' | grep -v grep | head -3 || true)"
if [ -z "$procs" ]; then echo "(no build running)"; else echo "$procs"; fi

echo "==> output:"
if ls live-build/*.iso >/dev/null 2>&1; then
    ls -lh live-build/*.iso | head -3
else
    echo "(no ISO yet)"
fi
if ls out/usbeliza-v*-amd64.iso >/dev/null 2>&1; then
    echo "    canonical:"
    ls -lh out/usbeliza-v*-amd64.iso | head -3 | sed 's/^/    /'
fi

echo "==> chroot size:"
if [ -d live-build/chroot ]; then
    sudo du -sh live-build/chroot 2>/dev/null || echo "(unreadable)"
else
    echo "(no chroot)"
fi

echo "==> last meaningful log lines (most-recent log in logs/):"
latest="$(ls -t logs/iso-build*.log 2>/dev/null | head -1)"
if [ -z "$latest" ]; then
    echo "(no log)"
    exit 0
fi
echo "[$latest]"
grep -aE '^\[20|^P: |^==>|^I: |^E: |^lb_|installed|Built|Iso image|squashfs' "$latest" | tail -12
