#!/usr/bin/env bash
# Build OpenSBI generic for QEMU virt with our e1 S-mode payload.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
EXT_DIR="$ROOT/external"
OPENSBI_DIR="$EXT_DIR/opensbi"
OPENSBI_TAG="${OPENSBI_TAG:-v1.4}"
PAYLOAD_DIR="$ROOT/fw/opensbi-payloads/e1-smode"
PAYLOAD_BIN="$PAYLOAD_DIR/e1.bin"
CROSS_COMPILE="${CROSS_COMPILE:-riscv64-unknown-elf-}"

mkdir -p "$EXT_DIR"

if [[ ! -d "$OPENSBI_DIR/.git" ]]; then
    echo "[opensbi] cloning $OPENSBI_TAG into $OPENSBI_DIR"
    git clone --depth 1 --branch "$OPENSBI_TAG" \
        https://github.com/riscv-software-src/opensbi.git "$OPENSBI_DIR"
else
    echo "[opensbi] reusing existing checkout at $OPENSBI_DIR"
fi

if [[ ! -f "$PAYLOAD_BIN" ]]; then
    echo "[opensbi] building payload first"
    make -C "$PAYLOAD_DIR" CROSS="$CROSS_COMPILE"
fi

echo "[opensbi] building generic platform with FW_PAYLOAD=$PAYLOAD_BIN"
make -C "$OPENSBI_DIR" \
    PLATFORM=generic \
    CROSS_COMPILE="$CROSS_COMPILE" \
    FW_PAYLOAD_PATH="$PAYLOAD_BIN" \
    -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)"

OUT="$OPENSBI_DIR/build/platform/generic/firmware/fw_payload.elf"
if [[ ! -f "$OUT" ]]; then
    echo "ERROR: expected $OUT was not produced" >&2
    exit 1
fi
echo "[opensbi] OK: $OUT"
