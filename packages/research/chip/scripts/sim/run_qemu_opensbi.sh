#!/usr/bin/env bash
# Tier 1: boot OpenSBI+payload on QEMU virt and assert banner + E1.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FW="${FW:-$ROOT/external/opensbi/build/platform/generic/firmware/fw_payload.elf}"
LOG_DIR="$ROOT/build/sim/qemu"
LOG="$LOG_DIR/tier1_opensbi.log"
TIMEOUT_SECS="${TIMEOUT_SECS:-10}"

mkdir -p "$LOG_DIR"

if [[ ! -f "$FW" ]]; then
    echo "ERROR: missing $FW -- build with: scripts/build/build_opensbi_qemu.sh" >&2
    exit 2
fi

TIMEOUT_BIN=""
if command -v gtimeout >/dev/null 2>&1; then
    TIMEOUT_BIN="gtimeout"
elif command -v timeout >/dev/null 2>&1; then
    TIMEOUT_BIN="timeout"
fi

CMD=(qemu-system-riscv64
     -machine virt
     -nographic
     -bios "$FW"
     -monitor none
     -serial mon:stdio
     -no-reboot)

echo "[tier1] running: ${CMD[*]}" | tee "$LOG"
set +e
if [[ -n "$TIMEOUT_BIN" ]]; then
    "$TIMEOUT_BIN" --foreground "${TIMEOUT_SECS}s" "${CMD[@]}" 2>&1 | tee -a "$LOG"
else
    "${CMD[@]}" 2>&1 | tee -a "$LOG"
fi
set -e

ok=1
if ! grep -qi "OpenSBI" "$LOG"; then
    echo "[tier1] FAIL: OpenSBI banner not seen" >&2
    ok=0
fi
if ! grep -q "E1 from S-mode" "$LOG"; then
    echo "[tier1] FAIL: payload string not seen" >&2
    ok=0
fi
if [[ "$ok" -eq 1 ]]; then
    echo "[tier1] PASS: OpenSBI banner + payload string present"
    exit 0
fi
exit 1
