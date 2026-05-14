#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 NubsCarson and contributors
#
# Live dev loop. Watches agent/src/ on the host, rsyncs to a running VM
# on every change, restarts eliza-agent.service. Two-second feedback
# loop instead of the 5-minute ISO rebuild + boot cycle.
#
# Prerequisites: a usbeliza VM is already running with SSH on :2223 (run
# scripts/run-vm.sh first, in another terminal). The VM's eliza-agent
# service must be writable by `sudo cp` from the eliza user — that's the
# default on the live ISO since eliza is in the sudoers file.
#
# Usage:
#   scripts/dev-watch.sh                                # default port 2223
#   scripts/dev-watch.sh --ssh-port 2233
#   scripts/dev-watch.sh --once                         # one-shot sync, no watch
#
# How it works:
#   1. Initial sync: rsync agent/src + sway config + systemd units to VM.
#   2. Restart eliza-agent.service.
#   3. Watch agent/src/ via inotifywait. On any change → rsync + restart.
#   4. Optional: tail eliza-agent journal in a sub-thread so you see
#      logs in real time as you save files.
#
# Why this works: live-build's chroot is mostly Debian packages.
# /opt/usbeliza/agent is our code; everything else is stable. We bypass
# the squashfs assembly entirely during dev.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

SSH_PORT=2223
ONCE=false
TAIL_JOURNAL=true

while (( $# )); do
    case "$1" in
        --ssh-port) SSH_PORT="$2"; shift 2 ;;
        --once) ONCE=true; shift ;;
        --no-journal) TAIL_JOURNAL=false; shift ;;
        -h|--help)
            head -25 "$0" | tail -22
            exit 0
            ;;
        *) echo "Unknown arg: $1" >&2; exit 1 ;;
    esac
done

SSH_KEY="vm/.ssh/usbeliza_dev_ed25519"
SSH_OPTS=(-i "$SSH_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -p "$SSH_PORT")
RSYNC_OPTS=(-a --delete --exclude=node_modules/.cache --exclude='*.tsbuildinfo')

# Ensure VM is reachable.
if ! ssh "${SSH_OPTS[@]}" -o ConnectTimeout=4 eliza@127.0.0.1 'true' 2>/dev/null; then
    cat >&2 <<EOF
ERROR: can't reach the VM on port $SSH_PORT.
Start one in another terminal with: scripts/run-vm.sh --windowed
EOF
    exit 1
fi

# Ensure inotifywait is installed (only needed for watch mode).
if [[ "$ONCE" == false ]] && ! command -v inotifywait >/dev/null; then
    echo "ERROR: inotifywait not installed. Run: sudo apt install inotify-tools" >&2
    exit 1
fi

sync_once() {
    local label="$1"
    local started=$EPOCHREALTIME
    rsync "${RSYNC_OPTS[@]}" -e "ssh ${SSH_OPTS[*]}" \
        agent/src/ eliza@127.0.0.1:/tmp/agent-src-new/ >/dev/null
    ssh "${SSH_OPTS[@]}" eliza@127.0.0.1 \
        'sudo rsync -a --delete /tmp/agent-src-new/ /opt/usbeliza/agent/src/ && sudo systemctl restart eliza-agent.service' >/dev/null
    local now=$EPOCHREALTIME
    local elapsed=$(awk "BEGIN { printf \"%.2f\", $now - $started }")
    printf '[%s] %s — synced + restarted in %ss\n' "$(date -u +%T)" "$label" "$elapsed"
}

echo "==> Initial sync"
sync_once "boot"

# Wait for agent to come back up.
echo "==> Waiting for /api/status ready..."
for _ in $(seq 1 20); do
    if ssh "${SSH_OPTS[@]}" eliza@127.0.0.1 \
        'curl -sf --max-time 2 http://127.0.0.1:41337/api/status' 2>/dev/null | grep -q '"state":"ready"'; then
        echo "==> Agent ready"
        break
    fi
    sleep 1
done

if [[ "$ONCE" == true ]]; then
    exit 0
fi

# Optional journal tail in a background subshell. Writes to fd 3 so it
# doesn't clobber the watcher's status output.
if [[ "$TAIL_JOURNAL" == true ]]; then
    (
        ssh "${SSH_OPTS[@]}" eliza@127.0.0.1 \
            'sudo journalctl -u eliza-agent.service -f --no-pager -n 0' 2>/dev/null \
            | sed -u 's/^/   [agent] /'
    ) &
    JOURNAL_PID=$!
    trap 'kill $JOURNAL_PID 2>/dev/null || true' EXIT INT TERM
fi

echo "==> Watching agent/src/ — save any file to trigger sync. Ctrl+C to stop."

# Coalesce bursts of file events into one sync. Editors (vim/nvim, vscode)
# write multiple times per save (atomic write via tmp + rename).
DEBOUNCE_MS=300
last_sync=0
while inotifywait -qq -r -e modify,close_write,create,delete,move agent/src/ 2>/dev/null; do
    now=$(date +%s%3N)
    if (( now - last_sync < DEBOUNCE_MS )); then
        continue
    fi
    last_sync=$now
    sync_once "edit"
done
