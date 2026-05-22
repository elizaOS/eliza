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

find_engine() {
    if [ -n "${E1_JETSTREAM_ENGINE_BIN:-}" ]; then
        [ -x "${E1_JETSTREAM_ENGINE_BIN}" ] && return 0
        write_blocked "E1_JETSTREAM_ENGINE_BIN is set but not executable: ${E1_JETSTREAM_ENGINE_BIN}"
    fi
    for candidate in \
        "${ROOT}/external/v8-riscv64/d8" \
        "${ROOT}/external/v8-riscv64/out/riscv64.release/d8" \
        "${ROOT}/external/v8-riscv64/out/riscv64.release/v8_shell" \
        "${ROOT}/external/hermes-riscv64/hermes" \
        "${ROOT}/external/hermes-riscv64/build/bin/hermes"; do
        [ -x "${candidate}" ] && return 0
    done
    return 1
}

if ! find_engine; then
    write_blocked "no executable JS engine RISC-V build available (set E1_JETSTREAM_ENGINE_BIN, or provide v8-riscv64 d8/v8_shell or hermes-riscv64 hermes)"
fi

DUT="${E1_JETSTREAM_DUT:-}"
if [ -z "${DUT}" ]; then
    write_blocked "E1_JETSTREAM_DUT not set; choose cuttlefish|qemu|board"
fi

write_blocked "DUT=${DUT} runner not implemented; JS engine + DUT must coexist on a target capable of running V8 with JIT at usable speed"
