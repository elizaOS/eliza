#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 NubsCarson and contributors
#
# Phase 0 vm-test smoke runner.
#
# Boots the qcow2 headless, waits for SSH + the in-VM listener, deploys the
# current host build into the VM, then drives a single canonical scenario:
# type "build me a calendar" → wait for ~/.eliza/apps/calendar/manifest.json
# → capture a guest screenshot → assert non-blank.
#
# Returns non-zero if any step fails. Designed to run under `just vm-test`
# locally and on the GitHub Actions nightly job.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

if [ ! -f vm/disk-base.qcow2 ]; then
    echo "error: vm/disk-base.qcow2 not found. Run 'just vm-build-base' first." >&2
    exit 1
fi
if [ ! -f vm/.ssh/usbeliza_dev_ed25519 ]; then
    echo "error: vm/.ssh/usbeliza_dev_ed25519 missing — re-run 'just vm-build-base'." >&2
    exit 1
fi

# --- Boot ---
echo "==> booting VM headless"
vm/scripts/boot.sh --headless --snapshot &
qemu_pid=$!

cleanup() {
    vm/scripts/teardown.sh >/dev/null 2>&1 || true
    kill "$qemu_pid" 2>/dev/null || true
}
trap cleanup EXIT

# --- SSH up ---
echo "==> waiting for SSH (90s deadline)"
if ! vm/scripts/inject.py wait-port 2222 90; then
    echo "FAIL: SSH forward (localhost:2222) did not come up" >&2
    exit 3
fi

# wait-port only checks TCP reachability; sshd's kex handshake may still be
# warming. Poll a real ssh round-trip until it succeeds (or 60s elapses).
echo "==> waiting for sshd handshake"
ssh_ready=0
for _ in $(seq 1 30); do
    if ssh \
        -i vm/.ssh/usbeliza_dev_ed25519 \
        -o StrictHostKeyChecking=no \
        -o UserKnownHostsFile=/dev/null \
        -o LogLevel=ERROR \
        -o ConnectTimeout=2 \
        -p 2222 \
        eliza@127.0.0.1 'true' 2>/dev/null; then
        ssh_ready=1
        break
    fi
    sleep 2
done
if [ "$ssh_ready" -ne 1 ]; then
    echo "FAIL: sshd never accepted a real ssh handshake" >&2
    exit 3
fi
echo "OK: SSH up + sshd ready"

# --- Deploy ---
echo "==> deploying host artifacts"
vm/scripts/deploy.sh
echo "OK: deploy"

# --- Listener heartbeat ---
echo "==> verifying in-VM input listener"
vm/scripts/inject.py ping
sleep 1

# --- The 5 canonical app scenarios ---
ssh_opts=(
    -i vm/.ssh/usbeliza_dev_ed25519
    -o StrictHostKeyChecking=no
    -o UserKnownHostsFile=/dev/null
    -o LogLevel=ERROR
    -p 2222
)

# Each entry: <slug> <"intent phrase">. A canonical app (PLAN.md
# milestone 11d pass criterion) is one that cold-builds via claude --print,
# validates, lands on disk under ~/.eliza/apps/<slug>/, and has a
# sandboxable webview entry. Order matches the canonical list.
declare -a SCENARIOS=(
    "calendar:build me a calendar"
    "notes:build me a notes app"
    "text-editor:build me a text-editor"
    "clock:build me a clock"
    "calculator:build me a calculator"
)

for entry in "${SCENARIOS[@]}"; do
    slug="${entry%%:*}"
    intent="${entry#*:}"

    # Drive the scenario via a direct POST to /api/chat. That tests the
    # full agent + intent-detector + codegen + manifest-validate + write
    # chain end-to-end inside the VM. (The wtype-into-chat-box path
    # depends on Wayland keyboard injection in a headless compositor —
    # works fine on bare metal, fiddly enough in QEMU that we use the
    # direct HTTP path for CI determinism. The chat-UI driving still
    # works manually via the elizad shell on a real boot.)
    intent_json=$(printf '%s' "$intent" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')
    echo "==> [$slug] POST /api/chat: $intent"
    ssh "${ssh_opts[@]}" eliza@127.0.0.1 \
        "curl -sf -X POST -H 'content-type: application/json' \
              -d '{\"message\":${intent_json}}' http://127.0.0.1:41337/api/chat" \
        > "vm/snapshots/${slug}-reply.json" || {
            echo "FAIL: [$slug] /api/chat returned non-200" >&2
            exit 3
        }

    echo "==> [$slug] reply:"
    head -c 200 "vm/snapshots/${slug}-reply.json"
    echo

    echo "==> [$slug] disk check via SSH"
    if ssh "${ssh_opts[@]}" eliza@127.0.0.1 \
        "test -f ~/.eliza/apps/${slug}/manifest.json && test -f ~/.eliza/apps/${slug}/src/index.html"; then
        echo "OK: [$slug] manifest + entry on disk"
    else
        echo "FAIL: [$slug] codegen artifacts not present on disk" >&2
        exit 3
    fi

    # Verify the manifest matches schema_version=1 and the requested slug.
    if ssh "${ssh_opts[@]}" eliza@127.0.0.1 \
        "python3 -c 'import json,sys; m=json.load(open(\"/home/eliza/.eliza/apps/${slug}/manifest.json\")); sys.exit(0 if m[\"slug\"]==\"${slug}\" and m[\"schema_version\"]==1 else 1)'"; then
        echo "OK: [$slug] manifest content sane"
    else
        echo "FAIL: [$slug] manifest content mismatch" >&2
        exit 3
    fi
done

# Pull screenshots back to host for the artifact.
scp_opts=(
    -i vm/.ssh/usbeliza_dev_ed25519
    -o StrictHostKeyChecking=no
    -o UserKnownHostsFile=/dev/null
    -o LogLevel=ERROR
    -P 2222
)
scp -r "${scp_opts[@]}" eliza@127.0.0.1:/var/tmp/usbeliza-screenshots vm/snapshots/guest-screenshots 2>/dev/null || true

# Take a QMP framebuffer screenshot too.
qmp_shot="vm/snapshots/qmp-after-build.png"
vm/scripts/inject.py screenshot "$qmp_shot"
size="$(stat -c %s "$qmp_shot")"
if [ "$size" -lt 1024 ]; then
    echo "FAIL: QMP screenshot too small ($size bytes)" >&2
    exit 3
fi
echo "OK: QMP screenshot captured ($size bytes)"

echo "==> Phase 0 vm-test passed"
