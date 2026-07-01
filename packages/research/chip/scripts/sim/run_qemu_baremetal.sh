#!/usr/bin/env bash
# Tier 0: boot bare-metal E1 on QEMU virt and assert serial output.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ELF="${ELF:-$ROOT/fw/bare-metal/e1/e1.elf}"
LOG_DIR="$ROOT/build/sim/qemu"
LOG="$LOG_DIR/tier0_baremetal.log"
TIMEOUT_SECS="${TIMEOUT_SECS:-5}"

mkdir -p "$LOG_DIR"

if [[ ! -f "$ELF" ]]; then
    echo "ERROR: missing $ELF -- build with: make -C fw/bare-metal/e1" >&2
    exit 2
fi

# Prefer gtimeout (coreutils on macOS via Homebrew), fall back to timeout.
TIMEOUT_BIN=""
if command -v gtimeout >/dev/null 2>&1; then
    TIMEOUT_BIN="gtimeout"
elif command -v timeout >/dev/null 2>&1; then
    TIMEOUT_BIN="timeout"
fi

CMD=(qemu-system-riscv64
     -machine virt
     -nographic
     -bios none
     -kernel "$ELF"
     -monitor none
     -serial mon:stdio
     -no-reboot)

echo "[tier0] running: ${CMD[*]}" | tee "$LOG"
set +e
if [[ -n "$TIMEOUT_BIN" ]]; then
    "$TIMEOUT_BIN" --foreground "${TIMEOUT_SECS}s" "${CMD[@]}" 2>&1 | tee -a "$LOG"
else
    # No timeout binary: rely on payload to halt via wfi; user must Ctrl-A x.
    "${CMD[@]}" 2>&1 | tee -a "$LOG"
fi
set -e

if grep -q "E1" "$LOG"; then
    echo "[tier0] PASS: saw E1 in serial log"
    exit 0
else
    echo "[tier0] FAIL: E1 not found in $LOG" >&2
    exit 1
fi
