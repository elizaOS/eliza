#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 NubsCarson and contributors
#
# Tiny QMP client for the running ISO QEMU (the one started by
# `just iso-boot-headless`). Speaks raw JSON over the unix socket at
# vm/snapshots/iso-qmp.sock.
#
# Sub-commands:
#   screenshot <path>   — write a PNG of the current framebuffer
#   send-key <qcode>    — send one keystroke (e.g. "ret", "esc", "down")
#
# Why this exists: just-recipe shell quoting around JSON-over-socat got
# painful enough that a 40-line bash script is clearer than wrestling
# with `$$(...)` and embedded double quotes inside `bash -c '...'`.

set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sock="$repo/vm/snapshots/iso-qmp.sock"

if [ ! -S "$sock" ]; then
    echo "QMP socket missing: $sock" >&2
    echo "Is the ISO running? Start it with: just iso-boot-headless" >&2
    exit 1
fi

if ! command -v socat >/dev/null 2>&1; then
    echo "socat not installed; apt install socat" >&2
    exit 1
fi

# Drive QMP from stdin → socat → stdout. Capabilities handshake first,
# then the real command, then a `quit-stdin` to make socat exit.
qmp() {
    {
        printf '{"execute":"qmp_capabilities"}\n'
        printf '%s\n' "$1"
    } | socat -t1 - "UNIX-CONNECT:$sock"
}

case "${1:-}" in
    screenshot)
        if [ $# -lt 2 ]; then
            echo "usage: iso-qmp.sh screenshot <output-path>" >&2
            exit 2
        fi
        # QEMU writes the PNG using its own cwd, so pass an absolute path.
        out="$(realpath -m "$2")"
        mkdir -p "$(dirname "$out")"
        printf -v cmd '{"execute":"screendump","arguments":{"filename":"%s","format":"png"}}' "$out"
        response="$(qmp "$cmd")"
        if printf '%s' "$response" | grep -q '"error"'; then
            echo "QMP error: $response" >&2
            exit 3
        fi
        # Give QEMU a moment to finish writing before we stat the file.
        for _ in 1 2 3 4 5; do
            [ -s "$out" ] && break
            sleep 0.2
        done
        if [ ! -s "$out" ]; then
            echo "screenshot empty: $out" >&2
            exit 3
        fi
        size="$(stat -c %s "$out")"
        echo "screenshot: $out ($size bytes)"
        ;;
    send-key)
        if [ $# -lt 2 ]; then
            echo "usage: iso-qmp.sh send-key <qcode>" >&2
            echo "  qcodes: ret, esc, spc, tab, up, down, left, right, f1-f12, a-z, 0-9" >&2
            exit 2
        fi
        qcode="$2"
        printf -v cmd '{"execute":"send-key","arguments":{"keys":[{"type":"qcode","data":"%s"}]}}' "$qcode"
        response="$(qmp "$cmd")"
        if printf '%s' "$response" | grep -q '"error"'; then
            echo "QMP error: $response" >&2
            exit 3
        fi
        echo "sent qcode: $qcode"
        ;;
    *)
        echo "usage: iso-qmp.sh {screenshot <path>|send-key <qcode>}" >&2
        exit 2
        ;;
esac
