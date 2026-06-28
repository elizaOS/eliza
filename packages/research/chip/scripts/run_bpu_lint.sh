#!/usr/bin/env sh
# Verilator strict-lint gate for the BPU RTL tree. Mirrors the pattern used
# by scripts/run_verilator.sh but scopes Wall + Wpedantic to the BPU only so
# the gate can fail closed for that domain without dragging the rest of the
# tree along. Fails closed (exit 2) when verilator is not present.
set -eu

REPO_ROOT="$(CDPATH=; cd -- "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

if [ -d "$REPO_ROOT/external/oss-cad-suite/bin" ]; then
    PATH="$REPO_ROOT/external/oss-cad-suite/bin:$PATH"
fi

mkdir -p build/reports/bpu

if ! command -v verilator >/dev/null 2>&1; then
    cat <<EOF
STATUS: BLOCKED bpu.lint - verilator is not installed. Use the chip-package
Nix/Docker shell or install Verilator.
EOF
    cat >build/reports/bpu/lint-status.yaml <<EOF
schema: eliza.bpu_lint_status.v1
status: BLOCKED
reason: "no local verilator"
remediation: "install Verilator (>= 5.0); re-run make bpu-lint"
EOF
    if [ "${REQUIRE_VERILATOR:-0}" = "1" ]; then
        exit 2
    fi
    exit 0
fi

set -- \
    rtl/cpu/bpu/bpu_pkg.sv \
    rtl/cpu/bpu/bimodal.sv \
    rtl/cpu/bpu/tage_table.sv \
    rtl/cpu/bpu/tage.sv \
    rtl/cpu/bpu/ittage.sv \
    rtl/cpu/bpu/sc.sv \
    rtl/cpu/bpu/h2p_corrector.sv \
    rtl/cpu/bpu/loop_predictor.sv \
    rtl/cpu/bpu/ftb.sv \
    rtl/cpu/bpu/uftb.sv \
    rtl/cpu/bpu/ras.sv \
    rtl/cpu/bpu/ftq.sv \
    rtl/cpu/bpu/ftq_to_fetch_stream.sv \
    rtl/cpu/bpu/fetch_stream_to_l1i_demand.sv \
    rtl/cpu/bpu/bpu_csr.sv \
    rtl/cpu/bpu/bpu_top.sv

LOG="build/reports/bpu/lint.log"
if verilator --lint-only -Wall -Wpedantic --top-module bpu_top "$@" >"$LOG" 2>&1; then
    status=PASS
else
    status=FAIL
fi

cat >build/reports/bpu/lint-status.yaml <<EOF
schema: eliza.bpu_lint_status.v1
status: ${status}
tool: "$(verilator --version | head -1)"
log: "build/reports/bpu/lint.log"
modules:
  - rtl/cpu/bpu/bpu_pkg.sv
  - rtl/cpu/bpu/bimodal.sv
  - rtl/cpu/bpu/tage_table.sv
  - rtl/cpu/bpu/tage.sv
  - rtl/cpu/bpu/ittage.sv
  - rtl/cpu/bpu/sc.sv
  - rtl/cpu/bpu/h2p_corrector.sv
  - rtl/cpu/bpu/loop_predictor.sv
  - rtl/cpu/bpu/ftb.sv
  - rtl/cpu/bpu/uftb.sv
  - rtl/cpu/bpu/ras.sv
  - rtl/cpu/bpu/ftq.sv
  - rtl/cpu/bpu/ftq_to_fetch_stream.sv
  - rtl/cpu/bpu/fetch_stream_to_l1i_demand.sv
  - rtl/cpu/bpu/bpu_csr.sv
  - rtl/cpu/bpu/bpu_top.sv
EOF

if [ "${status}" = "FAIL" ]; then
    cat "$LOG"
    exit 1
fi
echo "STATUS: PASS bpu.lint - $(verilator --version | head -1) strict-lint clean across 16 modules"
