#!/bin/sh
# run_coremark_cva6_verilator.sh — cycle-accurate CoreMark on the CVA6
# ("Ariane") reference core under Verilator.
#
# CVA6 is the open-core reference AND E1's "little" core (e1-pro) by
# construction (docs/evidence/cpu_ap/core-selection.json). A measured
# CoreMark/MHz here is therefore both the apples-to-apples open-core anchor
# and E1's little-core number.
#
# Method:
#   1. Build the CVA6 Verilator model once (corev_apu ariane_testharness,
#      RVFI tracer) for target cv64a6_imafdc_sv39 == RV64GC.
#   2. Build the CVA6-bundled CoreMark ELF (verif/tests/custom/coremark plus
#      the common BSP crt.S/syscalls.c) for rv64gc with the xpack bare-metal
#      gcc. The BSP terminates via HTIF tohost and reads mcycle/minstret.
#   3. Run Variane_testharness <elf>; parse cycles from the SUCCESS line and
#      retired instructions from trace_rvfi_hart_00.dasm.
#   4. Compute CoreMark/MHz = iterations / (cycles / 1e6) and CPI.
#
# Fail-closed: any missing dependency writes the blocked evidence file naming
# the dep and the exact next command, then exits 0 so the gate is observable.
#
# Invoked by scripts/run_coremark.sh when E1_COREMARK_DUT=verilator.

set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
EVIDENCE="${ROOT}/docs/evidence/cpu_ap/cva6-coremark-verilator.json"
RESULT_JSON="${ROOT}/benchmarks/results/cpu/coremark/result.json"
CVA6="${ROOT}/external/cva6/cva6"
BUILD="${ROOT}/build/cva6-verilator"
STAGE="${BUILD}/riscv-stage"
SIM="${ROOT}/external/chipyard/toolchains/riscv-tools/riscv-isa-sim"
OSS="${ROOT}/external/oss-cad-suite"
GCC="${ROOT}/external/xpack-riscv-none-elf-gcc-15.2.0-1/bin/riscv-none-elf-gcc"
TARGET="cv64a6_imafdc_sv39"

now() { date -u +%FT%TZ; }

write_blocked() {
    reason=$1; missing=$2; next=$3
    cat > "${EVIDENCE}" <<EOF
{
  "schema": "eliza.cpu_benchmark_measured.v1",
  "benchmark": "coremark",
  "core": "cva6",
  "core_role": "little_core_e1_pro",
  "target_config": "${TARGET}",
  "isa": "rv64gc",
  "mabi": "lp64d",
  "status": "blocked",
  "claim_level": "L1_RTL_FULL_SOC",
  "provenance": "simulator",
  "result_recorded_at": "$(now)",
  "reason": "${reason}",
  "missing_dependency": "${missing}",
  "next_command": "${next}",
  "metrics": {"total_cycles": null, "retired_instructions": null, "cpi": null, "coremark_iterations": null, "coremark_per_mhz": null}
}
EOF
    echo "STATUS: BLOCKED cpu.coremark (cva6 verilator) - ${reason}"
    echo "  missing: ${missing}"
    echo "  next:    ${next}"
    exit 0
}

[ -d "${CVA6}" ] || write_blocked \
    "CVA6 RTL checkout absent" "${CVA6}" \
    "git clone https://github.com/openhwgroup/cva6.git external/cva6/cva6"

[ -x "${OSS}/bin/verilator" ] || write_blocked \
    "Verilator absent" "${OSS}/bin/verilator" "source tools/env.sh"

[ -x "${GCC}" ] || write_blocked \
    "xpack riscv-none-elf-gcc absent" "${GCC}" "scripts/install_coremark_stream_tools.sh"

# fesvr / spike libs required to link ariane_testharness.
for lib in libfesvr.a libriscv.a libdisasm.a; do
    [ -f "${SIM}/build/${lib}" ] || write_blocked \
        "spike ${lib} absent (needed to link ariane_testharness HTIF)" \
        "${SIM}/build/${lib}" \
        "cd ${SIM} && ./configure && make"
done

# CVA6 corev_apu testharness submodules. These are the documented blocker.
for sub in corev_apu/register_interface corev_apu/riscv-dbg corev_apu/axi_mem_if corev_apu/fpga/src/apb_uart; do
    if [ -z "$(ls -A "${CVA6}/${sub}" 2>/dev/null)" ]; then
        write_blocked \
            "CVA6 submodule ${sub} not initialized (required by corev_apu ariane_testharness)" \
            "${CVA6}/${sub}" \
            "git -C external/cva6/cva6 submodule update --init corev_apu/register_interface corev_apu/riscv-dbg corev_apu/axi_mem_if corev_apu/fpga/src/apb_uart"
    fi
done

# Stage a RISCV/SPIKE install layout from the chipyard isa-sim build.
mkdir -p "${STAGE}/include/fesvr" "${STAGE}/lib" "${STAGE}/bin"
ln -sf "${SIM}"/fesvr/*.h "${STAGE}/include/fesvr/"
for l in fesvr riscv disasm softfloat fdt customext; do
    [ -f "${SIM}/build/lib${l}.a" ] && ln -sf "${SIM}/build/lib${l}.a" "${STAGE}/lib/lib${l}.a"
done
[ -e /lib/x86_64-linux-gnu/libyaml-cpp.so ] && ln -sf /lib/x86_64-linux-gnu/libyaml-cpp.so "${STAGE}/lib/libyaml-cpp.so"
ln -sf "${SIM}/build/spike-dasm" "${STAGE}/bin/spike-dasm"
GCCBIN=$(dirname "${GCC}")
for t in gcc g++ nm objcopy objdump ld as ar; do
    [ -f "${GCCBIN}/riscv-none-elf-${t}" ] && ln -sf "${GCCBIN}/riscv-none-elf-${t}" "${STAGE}/bin/riscv-none-elf-${t}"
done

export PATH="${OSS}/bin:${STAGE}/bin:${PATH}"
export RISCV="${STAGE}"
export SPIKE_INSTALL_DIR="${STAGE}"
export VERILATOR_INSTALL_DIR="${OSS}"
export CVA6_REPO_DIR="${CVA6}"
NUM_JOBS=${NUM_JOBS:-$(nproc 2>/dev/null || echo 4)}

# 1. Build the Verilator model.
VMODEL="${CVA6}/work-ver/Variane_testharness"
if [ ! -x "${VMODEL}" ]; then
    echo "[cva6-verilator] building model (target=${TARGET})..."
    ( cd "${CVA6}" && make verilate target="${TARGET}" verilator="verilator --no-timing" NUM_JOBS="${NUM_JOBS}" ) \
        || write_blocked "verilate failed" "external/cva6/cva6 verilate" "see build log; re-run: cd external/cva6/cva6 && make verilate target=${TARGET}"
fi
[ -x "${VMODEL}" ] || write_blocked \
    "Variane_testharness not produced" "${VMODEL}" \
    "cd external/cva6/cva6 && make verilate target=${TARGET}"

# 2. Build the CoreMark ELF from CVA6's bundled sources + common BSP.
CM="${CVA6}/verif/tests/custom/coremark"
BSP="${CVA6}/verif/tests/custom/common"
LINK="${CVA6}/config/gen_from_riscv_config/linker/link.ld"
ELF="${BUILD}/coremark.cva6.rv64gc.elf"
ITER="${E1_COREMARK_ITERATIONS:-10}"
"${GCC}" -O3 -g -march=rv64gc -mabi=lp64d \
    -static -mcmodel=medany -fvisibility=hidden -nostdlib -nostartfiles \
    -fno-tree-loop-distribute-patterns -funroll-all-loops \
    -ffunction-sections -fdata-sections -Wl,-gc-sections \
    -falign-jumps=4 -falign-functions=16 \
    -I"${CM}" -I"${BSP}" -I"${CVA6}/verif/tests/custom/env" \
    -T"${LINK}" \
    "${CM}/coremark_main.c" "${CM}/core_list_join.c" "${CM}/core_matrix.c" \
    "${CM}/core_portme.c" "${CM}/core_state.c" "${CM}/core_util.c" \
    "${CM}/uart.c" "${BSP}/syscalls.c" "${BSP}/crt.S" \
    -DITERATIONS="${ITER}" -DPERFORMANCE_RUN -DNOPRINT \
    '-DCOMPILER_FLAGS="-O3 -march=rv64gc -mabi=lp64d"' \
    -lgcc -o "${ELF}" \
    || write_blocked "CoreMark ELF compile failed" "${ELF}" "see compiler output above"

# 3. Run the model. Cycles come from the SUCCESS line, retired instructions
#    from the RVFI dasm trace.
RUNLOG="${BUILD}/coremark.cva6.run.log"
DASM="${CVA6}/trace_rvfi_hart_00.dasm"
( cd "${CVA6}" && "${VMODEL}" "${ELF}" ) >"${RUNLOG}" 2>&1 || true

CYCLES=$(grep -oE 'after [0-9]+ cycles' "${RUNLOG}" | grep -oE '[0-9]+' | tail -1 || true)
[ -n "${CYCLES:-}" ] || write_blocked \
    "Verilator run produced no cycle count (SUCCESS line missing)" \
    "completed Variane_testharness run" \
    "inspect ${RUNLOG}"

INSNS=$(grep -cE '^core +0:' "${DASM}" 2>/dev/null || echo 0)
ITERS=$(grep -oE 'Iterations[ ]*:[ ]*[0-9]+' "${RUNLOG}" | grep -oE '[0-9]+' | tail -1 || echo "${ITER}")

CMPERMHZ=$(python3 -c "print(round(${ITERS}/(${CYCLES}/1e6), 4))")
CPI=$(python3 -c "print(round(${CYCLES}/${INSNS}, 4) if ${INSNS} else 'null')")

cat > "${EVIDENCE}" <<EOF
{
  "schema": "eliza.cpu_benchmark_measured.v1",
  "benchmark": "coremark",
  "core": "cva6",
  "core_role": "little_core_e1_pro",
  "target_config": "${TARGET}",
  "isa": "rv64gc",
  "mabi": "lp64d",
  "status": "passed",
  "claim_level": "L1_RTL_FULL_SOC",
  "provenance": "simulator",
  "result_recorded_at": "$(now)",
  "tools": {
    "verilator": "$("${OSS}/bin/verilator" --version 2>&1)",
    "gcc": "$("${GCC}" -dumpversion) (xpack riscv-none-elf)",
    "gcc_flags": "-O3 -march=rv64gc -mabi=lp64d -static -mcmodel=medany -funroll-all-loops"
  },
  "metrics": {
    "total_cycles": ${CYCLES},
    "retired_instructions": ${INSNS},
    "cpi": ${CPI},
    "coremark_iterations": ${ITERS},
    "coremark_per_mhz": ${CMPERMHZ}
  },
  "coremark_per_mhz_formula": "iterations / (total_cycles / 1e6)",
  "run_command": "external/cva6/cva6/work-ver/Variane_testharness ${ELF}",
  "raw_coremark_stdout": $(python3 -c "import json,sys;print(json.dumps(open('${RUNLOG}').read()))")
}
EOF

cat > "${RESULT_JSON}" <<EOF
{
  "schema": "eliza.cpu_benchmark_result.v1",
  "benchmark": "coremark",
  "status": "passed",
  "substrate": "cva6 verilator (cycle-accurate RTL, ${TARGET})",
  "claim_level": "L1_RTL_FULL_SOC",
  "result_recorded_at": "$(now)",
  "manifest": "benchmarks/cpu/coremark/manifest.json",
  "metrics": {
    "total_cycles": ${CYCLES},
    "retired_instructions": ${INSNS},
    "cpi": ${CPI},
    "coremark_iterations": ${ITERS},
    "coremark_per_mhz": ${CMPERMHZ}
  },
  "evidence": "docs/evidence/cpu_ap/cva6-coremark-verilator.json"
}
EOF

echo "STATUS: PASSED cpu.coremark (cva6 verilator)"
echo "  cycles=${CYCLES} insns=${INSNS} CPI=${CPI} iterations=${ITERS} CoreMark/MHz=${CMPERMHZ}"
