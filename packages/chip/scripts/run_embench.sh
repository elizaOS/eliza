#!/bin/sh
# run_embench.sh — fail-closed Embench-IoT harness for the e1 CPU.

set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
MANIFEST="${ROOT}/benchmarks/cpu/embench/manifest.json"
RESULTS_DIR="${ROOT}/benchmarks/results/cpu/embench"
RESULT_JSON="${RESULTS_DIR}/result.json"
mkdir -p "${RESULTS_DIR}"

write_blocked() {
    reason=$1
    missing_dep=$2
    next_command=$3
    cat > "${RESULT_JSON}" <<EOF
{
  "schema": "eliza.cpu_benchmark_result.v1",
  "benchmark": "embench-iot",
  "status": "blocked",
  "reason": "${reason}",
  "missing_dependency": "${missing_dep}",
  "next_command": "${next_command}",
  "result_recorded_at": "$(date -u +%FT%TZ)",
  "manifest": "benchmarks/cpu/embench/manifest.json"
}
EOF
    echo "STATUS: BLOCKED cpu.embench - ${reason}"
    echo "  missing: ${missing_dep}"
    echo "  next:    ${next_command}"
    exit 0
}

[ -f "${MANIFEST}" ] || write_blocked \
    "missing manifest" "benchmarks/cpu/embench/manifest.json" "git ls-files | grep embench"

if [ ! -d "${ROOT}/external/embench-iot" ]; then
    write_blocked \
        "external/embench-iot/ checkout absent" \
        "external/embench-iot" \
        "git clone https://github.com/embench/embench-iot.git external/embench-iot --branch v1.0"
fi

GCC="${ROOT}/external/xpack-riscv-none-elf-gcc-15.2.0-1/bin/riscv-none-elf-gcc"
if [ ! -x "${GCC}" ]; then
    write_blocked \
        "xpack riscv-none-elf-gcc not on disk" \
        "${GCC}" \
        "scripts/install_coremark_stream_tools.sh"
fi

DUT="${E1_EMBENCH_DUT:-}"
if [ -z "${DUT}" ]; then
    write_blocked \
        "E1_EMBENCH_DUT not set" \
        "DUT selector" \
        "E1_EMBENCH_DUT=spike make embench   # or verilator|qemu|board"
fi

# Step: build embench under the upstream build_all.py script. The
# config-name parity is enforced in benchmarks/cpu/embench/manifest.json.
BUILD_DIR="${ROOT}/build/embench"
mkdir -p "${BUILD_DIR}"

cd "${ROOT}/external/embench-iot"
if [ ! -x "${ROOT}/external/embench-iot/build_all.py" ]; then
    write_blocked \
        "embench-iot checkout missing build_all.py" \
        "external/embench-iot/build_all.py" \
        "git -C external/embench-iot reset --hard origin/v1.0"
fi

# We expect the embench upstream Python build to be invoked here. For
# now leave a single blocking message keyed on DUT so the operator
# always sees a deterministic next-step.
case "${DUT}" in
    verilator)
        write_blocked \
            "verilator DUT runner not implemented" \
            "build/embench/embench.<bench>.rv64gc.elf and verilator runner harness" \
            "Implement scripts/run_embench_verilator.sh once Chipyard sim is built"
        ;;
    spike)
        SPIKE="${E1_SPIKE_BIN:-spike}"
        if ! command -v "${SPIKE}" >/dev/null 2>&1; then
            write_blocked \
                "spike not on PATH" \
                "${SPIKE}" \
                "apt install riscv64-elf-spike  OR  set E1_SPIKE_BIN=/path/to/spike"
        fi
        write_blocked \
            "spike runner stages the host-side build only" \
            "external/embench-iot/build_all.py run via spike" \
            "external/embench-iot/build_all.py --gcc ${GCC} --target riscv32 (software-reference only)"
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
            "qemu DUT runner gives software-reference numbers only" \
            "qemu-riscv64 wrapper" \
            "${QEMU} build/embench/<bench>.elf (software-reference only)"
        ;;
    board)
        write_blocked \
            "board DUT runner not implemented" \
            "e1 silicon" \
            "Tapeout milestone 2028H1; not available pre-silicon"
        ;;
    *)
        write_blocked \
            "unknown E1_EMBENCH_DUT=${DUT}" \
            "supported DUTs" \
            "E1_EMBENCH_DUT=verilator|spike|qemu|board make embench"
        ;;
esac
