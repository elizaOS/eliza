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

json_quote() {
    python3 -c 'import json, sys; print(json.dumps(sys.stdin.read()))'
}

write_blocked() {
    reason=$1
    missing_dep=$2
    next_command=$3
    reason_json=$(printf '%s' "${reason}" | json_quote)
    missing_dep_json=$(printf '%s' "${missing_dep}" | json_quote)
    next_command_json=$(printf '%s' "${next_command}" | json_quote)
    cat > "${RESULT_JSON}" <<EOF
{
  "schema": "eliza.cpu_benchmark_result.v1",
  "benchmark": "coremark",
  "status": "blocked",
  "reason": ${reason_json},
  "missing_dependency": ${missing_dep_json},
  "next_command": ${next_command_json},
  "result_recorded_at": "$(date -u +%FT%TZ)",
  "manifest": "benchmarks/cpu/coremark/manifest.json"
}
EOF
    echo "STATUS: BLOCKED cpu.coremark - ${reason}"
    echo "  missing: ${missing_dep}"
    echo "  next:    ${next_command}"
    exit 0
}

[ -f "${MANIFEST}" ] || write_blocked \
    "missing manifest" "${MANIFEST}" "git ls-files | grep coremark"

# Step 1: external/coremark/ checkout pinned in the manifest.
if [ ! -d "${ROOT}/external/coremark" ]; then
    write_blocked \
        "external/coremark/ checkout absent" \
        "external/coremark" \
        "git clone https://github.com/eembc/coremark.git external/coremark --branch v1.0.2"
fi

# Step 2: compiler available?
GCC="${ROOT}/external/xpack-riscv-none-elf-gcc-15.2.0-1/bin/riscv-none-elf-gcc"
if [ ! -x "${GCC}" ]; then
    write_blocked \
        "xpack riscv-none-elf-gcc absent" \
        "${GCC}" \
        "scripts/install_coremark_stream_tools.sh"
fi

# Step 3: DUT selector.
DUT="${E1_COREMARK_DUT:-}"
if [ -z "${DUT}" ]; then
    write_blocked \
        "E1_COREMARK_DUT not set" \
        "DUT selector" \
        "E1_COREMARK_DUT=spike make coremark   # or verilator|qemu|board"
fi

# Cycle-accurate path: the CVA6 ("Ariane") reference core, which is also
# E1's little core (e1-pro). The CVA6 Verilator runner builds its own CoreMark
# ELF from CVA6's bundled sources + bare-metal BSP, so it does not use the
# generic posix build below. Delegate before that build runs. Fail-closed; it
# writes its own evidence.
if [ "${DUT}" = "verilator" ]; then
    exec "${ROOT}/scripts/run_coremark_cva6_verilator.sh"
fi

# Step 4: Build CoreMark for rv64gc.
BUILD_DIR="${ROOT}/build/coremark"
mkdir -p "${BUILD_DIR}"
PORT_DIR="${ROOT}/external/coremark/posix"

if [ ! -d "${PORT_DIR}" ]; then
    write_blocked \
        "external/coremark/posix not present" \
        "${PORT_DIR}" \
        "git -C external/coremark checkout v1.0.2 -- posix/"
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

# Step 5: Hand off to DUT runner. (verilator is handled above, before the
# generic posix build, because the CVA6 runner builds its own ELF.)
case "${DUT}" in
    spike)
        SPIKE="${E1_SPIKE_BIN:-spike}"
        if ! command -v "${SPIKE}" >/dev/null 2>&1; then
            write_blocked \
                "spike not on PATH" \
                "${SPIKE}" \
                "apt install riscv64-elf-spike  OR  set E1_SPIKE_BIN=/path/to/spike"
        fi
        write_blocked \
            "spike runner gives software-reference number only" \
            "spike runner harness (not a hardware claim)" \
            "${SPIKE} ${BUILD_DIR}/coremark.rv64gc.elf"
        ;;
    qemu)
        QEMU="${ROOT}/external/xpack-qemu-riscv-9.2.4-1/bin/qemu-riscv64"
        if [ ! -x "${QEMU}" ]; then
            write_blocked \
                "qemu-riscv64 not present" \
                "${QEMU}" \
                "scripts/fetch_qemu_linux_payload.py"
        fi
        write_blocked \
            "qemu user-mode runner gives software-reference number only" \
            "qemu user-mode runner harness" \
            "${QEMU} ${BUILD_DIR}/coremark.rv64gc.elf"
        ;;
    board)
        write_blocked \
            "board DUT runner unavailable before silicon" \
            "e1 silicon" \
            "Tapeout milestone 2028H1; not available pre-silicon"
        ;;
    *)
        write_blocked \
            "unknown E1_COREMARK_DUT=${DUT}" \
            "supported DUTs" \
            "E1_COREMARK_DUT=verilator|spike|qemu|board make coremark"
        ;;
esac
