#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 NubsCarson and contributors
#
# Stop any running QEMU instance launched by vm/scripts/boot.sh and clean
# the snapshot/socket dir. Idempotent; safe to run when nothing is up.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

# Send graceful shutdown via QMP if the socket is still there.
qmp_sock="vm/snapshots/qmp.sock"
if [ -S "$qmp_sock" ]; then
    if command -v socat >/dev/null 2>&1; then
        echo "==> sending QMP system_powerdown"
        printf '{"execute":"qmp_capabilities"}\n{"execute":"system_powerdown"}\n' \
            | socat - "UNIX-CONNECT:$qmp_sock" >/dev/null 2>&1 || true
    fi
fi

# Allow up to 5s for graceful shutdown, then SIGTERM any leftover qemu we own.
sleep 5
pkill -f "qemu-system-x86_64.*vm/disk-base.qcow2" 2>/dev/null || true
sleep 1
pkill -9 -f "qemu-system-x86_64.*vm/disk-base.qcow2" 2>/dev/null || true

# Clean socket dir.
rm -f vm/snapshots/qmp.sock vm/snapshots/serial.sock vm/snapshots/input.sock
echo "==> teardown complete"
