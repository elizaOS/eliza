#!/bin/sh
# run_embench.sh — fail-closed Embench-IoT harness for the e1 CPU.

set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
RESULTS_DIR="${ROOT}/benchmarks/results/cpu/embench"
RESULT_JSON="${RESULTS_DIR}/result.json"
mkdir -p "${RESULTS_DIR}"

write_blocked() {
    reason=$1
    cat > "${RESULT_JSON}" <<EOF
{
  "schema": "eliza.cpu_benchmark_result.v1",
  "benchmark": "embench-iot",
  "status": "blocked",
  "reason": "${reason}",
  "result_recorded_at": "$(date -u +%FT%TZ)",
  "manifest": "benchmarks/cpu/embench/manifest.json"
}
EOF
    echo "STATUS: BLOCKED cpu.embench - ${reason}"
    exit 0
}

if [ ! -d "${ROOT}/external/embench-iot" ]; then
    write_blocked "external/embench-iot/ absent; clone https://github.com/embench/embench-iot.git at v1.0"
fi

GCC="${ROOT}/external/xpack-riscv-none-elf-gcc-15.2.0-1/bin/riscv-none-elf-gcc"
if [ ! -x "${GCC}" ]; then
    write_blocked "xpack riscv-none-elf-gcc not present at ${GCC}"
fi

DUT="${E1_EMBENCH_DUT:-}"
if [ -z "${DUT}" ]; then
    write_blocked "E1_EMBENCH_DUT not set; choose verilator|spike|qemu|board"
fi

write_blocked "DUT=${DUT} runner not implemented yet; pinned config is in manifest"
