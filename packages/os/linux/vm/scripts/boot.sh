#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 NubsCarson and contributors
#
# Boot the Phase 0 QEMU base image. Headless by default. Snapshot-mode by
# default so writes don't persist between runs. Exposes a virtio-serial input
# channel and a QMP socket for the test harness (vm/scripts/inject.py).
#
# Usage:
#   vm/scripts/boot.sh [--headless|--gui] [--snapshot|--persistent] [--wait-ssh]
#
# Defaults: --headless --snapshot

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

mode_display="headless"
mode_persist="snapshot"
wait_ssh=0

for arg in "$@"; do
    case "$arg" in
        --headless) mode_display="headless" ;;
        --gui)      mode_display="gui" ;;
        --snapshot) mode_persist="snapshot" ;;
        --persistent) mode_persist="persistent" ;;
        --wait-ssh) wait_ssh=1 ;;
        *) echo "unknown arg: $arg" >&2; exit 2 ;;
    esac
done

qcow2="vm/disk-base.qcow2"
if [ ! -f "$qcow2" ]; then
    echo "error: $qcow2 not found. Run 'just vm-build-base' first." >&2
    exit 1
fi

mkdir -p vm/snapshots
qmp_sock="vm/snapshots/qmp.sock"
serial_sock="vm/snapshots/serial.sock"
input_sock="vm/snapshots/input.sock"
ssh_port=2222

# Clean any stale sockets from previous runs.
rm -f "$qmp_sock" "$serial_sock" "$input_sock"

qemu_args=(
    qemu-system-x86_64
    -enable-kvm
    -cpu host
    -m 4G
    -smp 2

    -drive "file=$qcow2,format=qcow2,if=virtio${mode_persist:+,$([ "$mode_persist" = "snapshot" ] && echo snapshot=on || echo snapshot=off)}"

    # User-mode networking with SSH port forward for dev convenience.
    -netdev "user,id=net0,hostfwd=tcp::${ssh_port}-:22"
    -device virtio-net-pci,netdev=net0

    # QMP (QEMU monitor protocol) — used by the harness for screenshots.
    -qmp "unix:${qmp_sock},server,nowait"

    # Serial console — captured for journal of boot-time logs.
    -chardev "socket,id=serial0,path=${serial_sock},server=on,wait=off"
    -serial chardev:serial0

    # virtio-serial channel — the harness drives input through this. The
    # in-VM listener reads from /dev/virtio-ports/usbeliza.input.
    -chardev "socket,id=input0,path=${input_sock},server=on,wait=off"
    -device virtio-serial-pci
    -device "virtserialport,chardev=input0,name=usbeliza.input"

    # No audio — keeps the test surface tight and avoids host PulseAudio/PipeWire deps.
)

case "$mode_display" in
    headless)
        qemu_args+=(-display none -vga virtio)
        ;;
    gui)
        # virtio-gpu-pci creates a proper /dev/dri/card0 in the guest so
        # sway's DRM backend has something to render to. `-vga none` keeps
        # the framebuffer slot free for it. gl=es matches what most modern
        # virtio_gpu drivers want.
        qemu_args+=(
            -display gtk,gl=on
            -vga none
            -device virtio-gpu-gl-pci
            -device virtio-keyboard-pci
            -device virtio-tablet-pci
        )
        ;;
esac

echo "==> booting $qcow2 ($mode_display, $mode_persist)"
echo "    QMP socket:    $qmp_sock"
echo "    serial socket: $serial_sock"
echo "    input socket:  $input_sock"
echo "    ssh forward:   localhost:$ssh_port"

# In gui mode we boot, wait for SSH, then swap the session unit from
# headless to interactive (DRM). The swap is ephemeral because the VM
# is in snapshot=on mode — the change lives in the writable overlay
# for the duration of this boot only.
#
# Doing the swap at runtime (not at build time) means the qcow2 stays
# canonically configured for headless smoke; `just vm-test` keeps
# working without a second image.
if [ "$mode_display" = "gui" ]; then
    "${qemu_args[@]}" &
    qemu_pid=$!

    # Wait for SSH, then swap units. Done in a background subshell so we
    # don't block the QEMU window from rendering.
    (
        ssh_key="vm/.ssh/usbeliza_dev_ed25519"
        ssh_opts=(-i "$ssh_key" -o StrictHostKeyChecking=no
                  -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR
                  -p "$ssh_port" -o ConnectTimeout=2)
        for i in $(seq 1 60); do
            if ssh "${ssh_opts[@]}" eliza@127.0.0.1 true 2>/dev/null; then break; fi
            sleep 1
        done
        echo "==> gui: swapping elizad-session.service → elizad-session-interactive.service"
        ssh "${ssh_opts[@]}" eliza@127.0.0.1 \
            'sudo systemctl disable --now elizad-session.service \
             && sudo systemctl enable --now elizad-session-interactive.service' \
            || echo "warn: unit swap failed; sway likely already up in headless mode"
    ) &

    # Hand the foreground back to QEMU so the GTK window stays interactive.
    wait "$qemu_pid"
    exit $?
fi

exec "${qemu_args[@]}"
