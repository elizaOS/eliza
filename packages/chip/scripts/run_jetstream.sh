#!/bin/sh
# run_jetstream.sh — JetStream 2 harness for the e1 CPU AP.

set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
RESULTS_DIR="${ROOT}/benchmarks/results/cpu/jetstream"
RESULT_JSON="${RESULTS_DIR}/result.json"
mkdir -p "${RESULTS_DIR}"

write_blocked() {
    reason=$1
    cat > "${RESULT_JSON}" <<EOF
{
  "schema": "eliza.cpu_benchmark_result.v1",
  "benchmark": "jetstream2",
  "status": "blocked",
  "reason": "${reason}",
  "result_recorded_at": "$(date -u +%FT%TZ)",
  "manifest": "benchmarks/cpu/jetstream/manifest.json"
}
EOF
    echo "STATUS: BLOCKED cpu.jetstream2 - ${reason}"
    exit 0
}

if [ ! -d "${ROOT}/external/v8-riscv64" ] && [ ! -d "${ROOT}/external/hermes-riscv64" ]; then
    write_blocked "no JS engine RISC-V build available (need v8-riscv64 or hermes-riscv64)"
fi

DUT="${E1_JETSTREAM_DUT:-}"
if [ -z "${DUT}" ]; then
    write_blocked "E1_JETSTREAM_DUT not set; choose cuttlefish|qemu|board"
fi

write_blocked "DUT=${DUT} runner not implemented; JS engine + DUT must coexist on a target capable of running V8 with JIT at usable speed"
