#!/bin/sh
# run_coremark.sh — fail-closed CoreMark harness for the e1 CPU.
#
# Invoked by `make coremark`. Builds the standard CoreMark with
# riscv-none-elf-gcc and a small e1-chip linker script, then runs it on
# whichever DUT the operator selects via E1_COREMARK_DUT (verilator,
# spike, qemu, board). Emits benchmarks/results/cpu/coremark/result.json
# regardless of outcome so the gate is observable.
#
# Pinned dependencies live in benchmarks/cpu/coremark/manifest.json.

set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
MANIFEST="${ROOT}/benchmarks/cpu/coremark/manifest.json"
RESULTS_DIR="${ROOT}/benchmarks/results/cpu/coremark"
RESULT_JSON="${RESULTS_DIR}/result.json"
mkdir -p "${RESULTS_DIR}"

write_blocked() {
    reason=$1
    cat > "${RESULT_JSON}" <<EOF
{
  "schema": "eliza.cpu_benchmark_result.v1",
  "benchmark": "coremark",
  "status": "blocked",
  "reason": "${reason}",
  "result_recorded_at": "$(date -u +%FT%TZ)",
  "manifest": "benchmarks/cpu/coremark/manifest.json"
}
EOF
    echo "STATUS: BLOCKED cpu.coremark - ${reason}"
    exit 0
}

[ -f "${MANIFEST}" ] || write_blocked "missing manifest: ${MANIFEST}"

# Step 1: external/coremark/ checkout pinned in the manifest.
if [ ! -d "${ROOT}/external/coremark" ]; then
    write_blocked "external/coremark/ checkout absent; clone https://github.com/eembc/coremark.git at v1.0.2"
fi

# Step 2: compiler available?
GCC="${ROOT}/external/xpack-riscv-none-elf-gcc-15.2.0-1/bin/riscv-none-elf-gcc"
if [ ! -x "${GCC}" ]; then
    write_blocked "xpack riscv-none-elf-gcc not present at ${GCC}"
fi

# Step 3: DUT selector.
DUT="${E1_COREMARK_DUT:-}"
if [ -z "${DUT}" ]; then
    write_blocked "E1_COREMARK_DUT not set; choose verilator|spike|qemu|board"
fi

# Step 4: Build CoreMark for rv64gc.
BUILD_DIR="${ROOT}/build/coremark"
mkdir -p "${BUILD_DIR}"
PORT_DIR="${ROOT}/external/coremark/posix"

if [ ! -d "${PORT_DIR}" ]; then
    write_blocked "external/coremark/posix not present; checkout incomplete"
fi

(
    cd "${ROOT}/external/coremark" || exit 1
    "${GCC}" \
        -O3 -march=rv64gc -mabi=lp64d \
        -Iposix -I. \
        core_list_join.c core_main.c core_matrix.c core_state.c core_util.c \
        posix/core_portme.c \
        -DITERATIONS=2000 -DPERFORMANCE_RUN=1 -DCOMPILER_FLAGS=\"-O3\" \
        -o "${BUILD_DIR}/coremark.rv64gc.elf"
)

# Step 5: Hand off to DUT runner.
case "${DUT}" in
    verilator)
        write_blocked "verilator DUT runner not implemented yet; binary at ${BUILD_DIR}/coremark.rv64gc.elf"
        ;;
    spike)
        SPIKE="${E1_SPIKE_BIN:-spike}"
        if ! command -v "${SPIKE}" >/dev/null 2>&1; then
            write_blocked "spike not on PATH and E1_SPIKE_BIN not set"
        fi
        write_blocked "spike runner: spike ${BUILD_DIR}/coremark.rv64gc.elf (gives software-reference number only; not a hardware claim)"
        ;;
    qemu)
        QEMU="${ROOT}/external/xpack-qemu-riscv-9.2.4-1/bin/qemu-riscv64"
        if [ ! -x "${QEMU}" ]; then
            write_blocked "qemu-riscv64 not present at ${QEMU}"
        fi
        write_blocked "qemu user-mode runner: ${QEMU} ${BUILD_DIR}/coremark.rv64gc.elf (software-reference only)"
        ;;
    board)
        write_blocked "board DUT runner not implemented; no e1 silicon available"
        ;;
    *)
        write_blocked "unknown E1_COREMARK_DUT=${DUT}; choose verilator|spike|qemu|board"
        ;;
esac
