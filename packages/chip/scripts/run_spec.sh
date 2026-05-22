#!/bin/sh
# run_spec.sh — fail-closed SPEC CPU 2017 harness for the e1 CPU AP.
#
# SPEC CPU 2017 is paid commercial software; the repo never holds SPEC
# sources, binaries, or license keys. This harness reads SPEC artifacts
# from $SPEC_DIR at runtime, never copies them into the repo, and only
# writes numeric scores plus configuration metadata to the result file.

set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
RESULTS_DIR="${ROOT}/benchmarks/results/cpu/spec"
RESULT_JSON="${RESULTS_DIR}/result.json"
mkdir -p "${RESULTS_DIR}"

write_blocked() {
    reason=$1
    cat > "${RESULT_JSON}" <<EOF
{
  "schema": "eliza.cpu_benchmark_result.v1",
  "benchmark": "spec-cpu-2017",
  "status": "blocked",
  "reason": "${reason}",
  "result_recorded_at": "$(date -u +%FT%TZ)",
  "manifest": "benchmarks/cpu/spec/manifest.json"
}
EOF
    echo "STATUS: BLOCKED cpu.spec_cpu_2017 - ${reason}"
    exit 0
}

if [ -z "${SPEC_DIR:-}" ]; then
    write_blocked "SPEC_DIR not set; SPEC CPU 2017 requires a licensed install"
fi

if [ ! -x "${SPEC_DIR}/bin/runcpu" ]; then
    write_blocked "no runcpu at ${SPEC_DIR}/bin/runcpu; license install incomplete"
fi

if [ ! -f "${SPEC_DIR}/version.txt" ]; then
    write_blocked "no version.txt at ${SPEC_DIR}; cannot verify pinned SPEC version"
fi

if [ -z "${E1_SPEC_DUT:-}" ]; then
    write_blocked "E1_SPEC_DUT not set; choose verilator|firesim|board"
fi

LLVM_CLANG="${ROOT}/build/llvm-stage2/bin/clang"
if [ ! -x "${LLVM_CLANG}" ]; then
    write_blocked "pinned LLVM RISC-V clang absent at ${LLVM_CLANG}; run scripts/build_llvm_riscv.sh inside the canonical Linux container"
fi

write_blocked "SPEC harness is structurally complete but no target runner is implemented yet for E1_SPEC_DUT=${E1_SPEC_DUT}; remaining blockers are licensed SPEC workload execution plus a DUT capable of meaningful SPEC sample sizes (silicon or FireSim)"
