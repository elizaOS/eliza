#!/usr/bin/env bash
# Build the persistent Linux disk image through the pinned mkosi container.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ "$#" == 1 && ( "$1" == --help || "$1" == -h ) ]]; then
    echo "usage: $0 [ARCH=amd64|arm64|riscv64] [PROFILE=default|gui|secure|secure-gui]"
    echo "For the legacy live ISO, use make -C $HERE legacy-iso."
    exit 0
fi
for argument in "$@"; do
    case "$argument" in
        ARCH=amd64|ARCH=arm64|ARCH=riscv64|PROFILE=default|PROFILE=gui|PROFILE=secure|PROFILE=secure-gui) ;;
        *)
            printf 'ERROR: expected ARCH=amd64|arm64|riscv64 or PROFILE=default|gui|secure|secure-gui; got %s\n' "$argument" >&2
            exit 64
            ;;
    esac
done
exec make -C "$HERE" build \
    "ARCH=${ELIZAOS_ARCH:-amd64}" "PROFILE=${ELIZAOS_PROFILE:-default}" "$@"
