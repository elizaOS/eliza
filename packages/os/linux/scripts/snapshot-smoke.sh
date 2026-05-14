#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 NubsCarson and contributors
#
# Snapshot-based smoke harness. ~20 seconds instead of 90.
#
# Real distros use a "prepared state" — boot once, take a savevm
# snapshot, load it for every subsequent test run. We never re-boot.
#
# Pipeline:
#   1. boot v15 ISO once (90s), wait until /api/status returns ready
#   2. QMP `human-monitor-command savevm ready` writes a memory+disk
#      snapshot to the qcow2 overlay
#   3. for each test scenario: QMP `loadvm ready` (<3s), run probes,
#      QMP `quit` if done, else next loadvm
#
# Usage:
#   scripts/snapshot-smoke.sh out/usbeliza-v15-final-amd64.iso
#   scripts/snapshot-smoke.sh --recreate          # nuke snapshot and re-prepare
#
# Requires: an overlay qcow2 so QEMU can write snapshots (live ISOs are
# read-only). We create one with backing-file = the ISO.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

ISO="${1:-}"
[[ -z "$ISO" ]] && ISO="$(ls -t out/usbeliza-v*-final-amd64.iso 2>/dev/null | head -1 || true)"
if [[ -z "$ISO" || ! -f "$ISO" ]]; then
    echo "ERROR: no ISO found." >&2
    exit 1
fi

RECREATE=false
[[ "${2:-}" == "--recreate" ]] && RECREATE=true

OVERLAY="vm/snapshots/snapshot-smoke.qcow2"
QMP_SOCK="vm/snapshots/snapshot-smoke-qmp.sock"
SSH_PORT=2227
SSH_KEY="vm/.ssh/usbeliza_dev_ed25519"
SSH_OPTS=(-i "$SSH_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -p "$SSH_PORT")

mkdir -p "$(dirname "$OVERLAY")"

cleanup() {
    if [[ -S "$QMP_SOCK" ]]; then
        printf '{"execute":"qmp_capabilities"}\n{"execute":"quit"}\n' \
            | timeout 5 socat - "UNIX-CONNECT:$QMP_SOCK" >/dev/null 2>&1 || true
    fi
    sudo pkill -9 -f "qemu-system-x86_64.*snapshot-smoke" 2>/dev/null || true
    rm -f "$QMP_SOCK"
}
trap cleanup EXIT INT TERM

qmp() {
    printf '{"execute":"qmp_capabilities"}\n%s\n' "$1" \
        | timeout 8 socat - "UNIX-CONNECT:$QMP_SOCK" 2>/dev/null \
        | tail -n +2
}

# Create overlay if missing or recreate requested.
# The overlay's backing file is the ISO itself; writes (including the
# savevm payload) go into the overlay, not the read-only ISO. This lets
# us use qcow2 snapshots against a CD-ROM source.
if [[ "$RECREATE" == true || ! -f "$OVERLAY" ]]; then
    echo "==> Creating overlay qcow2 backed by ISO"
    rm -f "$OVERLAY"
    qemu-img create -f qcow2 -b "$(realpath "$ISO")" -F raw "$OVERLAY" 20G >/dev/null
fi

# Quick snapshot existence check via qemu-img info. If the "ready"
# snapshot already exists, we skip the prepare phase.
HAS_READY=false
if qemu-img info "$OVERLAY" 2>/dev/null | grep -q 'ready '; then
    HAS_READY=true
fi

start_vm() {
    nohup sudo -n qemu-system-x86_64 \
        -enable-kvm -cpu host -m 4G -smp 4 \
        -drive "file=$OVERLAY,format=qcow2,if=virtio,media=cdrom,readonly=off" \
        -boot d \
        -netdev "user,id=net0,hostfwd=tcp::${SSH_PORT}-:22" \
        -device virtio-net-pci,netdev=net0 \
        -vga none -device virtio-vga,xres=1920,yres=1080 \
        -display none -nographic \
        -qmp "unix:${QMP_SOCK},server,nowait" \
        -name snapshot-smoke \
        > vm/snapshots/snapshot-smoke-qemu.log 2>&1 &
    sleep 1
    for _ in $(seq 1 30); do [[ -S "$QMP_SOCK" ]] && break; sleep 0.5; done
    sudo chmod 660 "$QMP_SOCK" 2>/dev/null || true
}

prepare_snapshot() {
    echo "==> No 'ready' snapshot found — booting fresh and preparing one"
    start_vm
    echo "==> Waiting for SSH + /api/status ready (up to 5 min)..."
    DEADLINE=$(( SECONDS + 300 ))
    while (( SECONDS < DEADLINE )); do
        if ssh "${SSH_OPTS[@]}" -o ConnectTimeout=4 eliza@127.0.0.1 \
            'curl -sf --max-time 3 http://127.0.0.1:41337/api/status' 2>/dev/null \
            | grep -q '"state":"ready"'; then
            break
        fi
        sleep 4
    done
    # Wipe state + pre-seed calibration so the snapshot is action-surface ready.
    ssh "${SSH_OPTS[@]}" eliza@127.0.0.1 \
        'rm -rf ~/.eliza/apps ~/.eliza/wallpapers ~/.eliza/auth ~/.eliza/flow.toml ~/.eliza/onboarding.toml && \
         mkdir -p ~/.eliza/models && touch ~/.eliza/models/Llama-3.2-1B-Instruct-Q4_K_M.gguf && \
         cat > ~/.eliza/calibration.toml <<TOML
schema_version = 1
created_at = "2026-05-12T00:00:00Z"
name = "Sam"
work_focus = "writing code"
multitasking = "multi-task"
chronotype = "morning"
error_communication = "transparent"
keyboard_layout = "us"
language = "en_US.UTF-8"
timezone = "UTC"
wifi_offer_accepted = false
claude_offer_accepted = false
TOML
'
    echo "==> Taking savevm snapshot 'ready'"
    qmp '{"execute":"human-monitor-command","arguments":{"command-line":"savevm ready"}}'
    echo "==> Snapshot saved"
    # Kill the VM so loadvm starts cleanly.
    qmp '{"execute":"quit"}' >/dev/null || true
    rm -f "$QMP_SOCK"
    sleep 1
}

run_smoke() {
    echo "==> Loading 'ready' snapshot"
    start_vm
    sleep 1
    qmp '{"execute":"human-monitor-command","arguments":{"command-line":"loadvm ready"}}'
    # SSH should be reachable in <5s after loadvm — the kernel + agent
    # are already in the snapshot's memory image.
    for _ in $(seq 1 20); do
        if ssh "${SSH_OPTS[@]}" -o ConnectTimeout=2 eliza@127.0.0.1 \
            'curl -sf --max-time 1 http://127.0.0.1:41337/api/status' 2>/dev/null \
            | grep -q '"state":"ready"'; then
            break
        fi
        sleep 0.5
    done
    # Hand off to the same probe set v11-e2e uses. For now just smoke a few.
    echo "==> Probing"
    for msg in "help" "what time is it" "list my apps" "build me a clock"; do
        reply="$(ssh "${SSH_OPTS[@]}" eliza@127.0.0.1 \
            "curl -s -X POST http://127.0.0.1:41337/api/chat -H 'Content-Type: application/json' --data-binary '{\"message\":\"$msg\"}'" 2>/dev/null \
            | python3 -c 'import sys,json; print(json.load(sys.stdin).get("reply","<no reply>"))' 2>/dev/null \
            | head -c 80)"
        printf '  %-32s → %s\n' "$msg" "${reply:-<empty>}"
    done
}

if [[ "$HAS_READY" == false ]]; then
    prepare_snapshot
fi

START=$EPOCHREALTIME
run_smoke
END=$EPOCHREALTIME
echo "==> Done in $(awk "BEGIN { printf \"%.1fs\", $END - $START }")"
