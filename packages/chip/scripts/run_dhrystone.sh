#!/bin/sh
# run_dhrystone.sh — cycle-accurate Dhrystone on the CVA6 ("Ariane")
# reference core under Verilator. CVA6 RV64GC is the open-core reference and
# E1's "little" core (e1-pro), so a measured DMIPS/MHz is both.
#
# Mirrors scripts/run_coremark_cva6_verilator.sh: builds the CVA6 Verilator
# model once, builds the CVA6-bundled Dhrystone ELF with the common BSP,
# runs it to HTIF tohost completion, and parses cycles from the SUCCESS line
# and retired instructions from the RVFI dasm trace.
#
#   DMIPS/MHz = (1e6 / cycles_per_dhrystone) / 1757
#   CPI       = total_cycles / retired_instructions
#
# Fail-closed: any missing dependency writes the blocked result naming the dep
# and the exact next command, then exits 0 so the gate is observable.
#
# Pinned dependencies live in benchmarks/cpu/dhrystone/manifest.json.

set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
MANIFEST="${ROOT}/benchmarks/cpu/dhrystone/manifest.json"
RESULTS_DIR="${ROOT}/benchmarks/results/cpu/dhrystone"
RESULT_JSON="${RESULTS_DIR}/result.json"
EVIDENCE="${ROOT}/docs/evidence/cpu_ap/cva6-dhrystone-verilator.json"
CVA6="${ROOT}/external/cva6/cva6"
BUILD="${ROOT}/build/cva6-verilator"
STAGE="${BUILD}/riscv-stage"
SIM="${ROOT}/external/chipyard/toolchains/riscv-tools/riscv-isa-sim"
OSS="${ROOT}/external/oss-cad-suite"
GCC="${ROOT}/external/xpack-riscv-none-elf-gcc-15.2.0-1/bin/riscv-none-elf-gcc"
TARGET="cv64a6_imafdc_sv39"
RUNS="${E1_DHRYSTONE_RUNS:-1000}"
mkdir -p "${RESULTS_DIR}"

now() { date -u +%FT%TZ; }

write_blocked() {
    reason=$1; missing=$2; next=$3
    cat > "${RESULT_JSON}" <<EOF
{
  "schema": "eliza.cpu_benchmark_result.v1",
  "benchmark": "dhrystone",
  "status": "blocked",
  "reason": "${reason}",
  "missing_dependency": "${missing}",
  "next_command": "${next}",
  "result_recorded_at": "$(now)",
  "manifest": "benchmarks/cpu/dhrystone/manifest.json",
  "evidence": "docs/evidence/cpu_ap/cva6-dhrystone-verilator.json"
}
EOF
    cat > "${EVIDENCE}" <<EOF
{
  "schema": "eliza.cpu_benchmark_measured.v1",
  "benchmark": "dhrystone",
  "core": "cva6",
  "core_role": "little_core_e1_pro",
  "target_config": "${TARGET}",
  "isa": "rv64gc",
  "mabi": "lp64d",
  "status": "blocked",
  "claim_level": "L1_RTL_FULL_SOC",
  "provenance": "simulator",
  "result_recorded_at": "$(now)",
  "dmips_per_mhz_formula": "(1e6 / cycles_per_dhrystone) / 1757",
  "reason": "${reason}",
  "missing_dependency": "${missing}",
  "next_command": "${next}",
  "metrics": {"total_cycles": null, "retired_instructions": null, "cpi": null, "dhrystone_runs": null, "cycles_per_dhrystone": null, "dmips_per_mhz": null}
}
EOF
    echo "STATUS: BLOCKED cpu.dhrystone (cva6 verilator) - ${reason}"
    echo "  missing: ${missing}"
    echo "  next:    ${next}"
    exit 0
}

[ -f "${MANIFEST}" ] || write_blocked "missing manifest" "${MANIFEST}" "git ls-files | grep dhrystone"
[ -d "${CVA6}" ] || write_blocked "CVA6 RTL checkout absent" "${CVA6}" \
    "git clone https://github.com/openhwgroup/cva6.git external/cva6/cva6"
[ -x "${OSS}/bin/verilator" ] || write_blocked "Verilator absent" "${OSS}/bin/verilator" "source tools/env.sh"
[ -x "${GCC}" ] || write_blocked "xpack riscv-none-elf-gcc absent" "${GCC}" "scripts/install_coremark_stream_tools.sh"

for lib in libfesvr.a libriscv.a libdisasm.a; do
    [ -f "${SIM}/build/${lib}" ] || write_blocked \
        "spike ${lib} absent (needed to link ariane_testharness HTIF)" \
        "${SIM}/build/${lib}" "cd ${SIM} && ./configure && make"
done

for sub in corev_apu/register_interface corev_apu/riscv-dbg corev_apu/axi_mem_if corev_apu/fpga/src/apb_uart; do
    if [ -z "$(ls -A "${CVA6}/${sub}" 2>/dev/null)" ]; then
        write_blocked \
            "CVA6 submodule ${sub} not initialized (required by corev_apu ariane_testharness)" \
            "${CVA6}/${sub}" \
            "git -C external/cva6/cva6 submodule update --init corev_apu/register_interface corev_apu/riscv-dbg corev_apu/axi_mem_if corev_apu/fpga/src/apb_uart"
    fi
done

# Stage RISCV/SPIKE layout (shared with the coremark runner).
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
export RISCV="${STAGE}" SPIKE_INSTALL_DIR="${STAGE}" VERILATOR_INSTALL_DIR="${OSS}" CVA6_REPO_DIR="${CVA6}"
NUM_JOBS=${NUM_JOBS:-$(nproc 2>/dev/null || echo 4)}

VMODEL="${CVA6}/work-ver/Variane_testharness"
if [ ! -x "${VMODEL}" ]; then
    echo "[cva6-verilator] building model (target=${TARGET})..."
    ( cd "${CVA6}" && make verilate target="${TARGET}" verilator="verilator --no-timing" NUM_JOBS="${NUM_JOBS}" ) \
        || write_blocked "verilate failed" "external/cva6/cva6 verilate" "cd external/cva6/cva6 && make verilate target=${TARGET}"
fi
[ -x "${VMODEL}" ] || write_blocked "Variane_testharness not produced" "${VMODEL}" \
    "cd external/cva6/cva6 && make verilate target=${TARGET}"

DH="${CVA6}/verif/tests/custom/dhrystone"
BSP="${CVA6}/verif/tests/custom/common"
LINK="${CVA6}/config/gen_from_riscv_config/linker/link.ld"
ELF="${BUILD}/dhrystone.cva6.rv64gc.elf"
"${GCC}" -O3 -march=rv64gc -mabi=lp64d \
    -static -mcmodel=medany -fvisibility=hidden -nostdlib -nostartfiles \
    -fno-tree-loop-distribute-patterns --no-inline \
    -Wno-implicit-function-declaration -Wno-implicit-int \
    -I"${DH}" -I"${BSP}" -I"${CVA6}/verif/tests/custom/env" \
    -T"${LINK}" \
    "${DH}/dhrystone_main.c" "${DH}/dhrystone.c" "${BSP}/syscalls.c" "${BSP}/crt.S" \
    -DDHRY_ITERS="${RUNS}" -DNOPRINT \
    -lgcc -o "${ELF}" \
    || write_blocked "Dhrystone ELF compile failed" "${ELF}" "see compiler output above"

RUNLOG="${BUILD}/dhrystone.cva6.run.log"
DASM="${CVA6}/trace_rvfi_hart_00.dasm"
( cd "${CVA6}" && "${VMODEL}" "${ELF}" ) >"${RUNLOG}" 2>&1 || true

CYCLES=$(grep -oE 'after [0-9]+ cycles' "${RUNLOG}" | grep -oE '[0-9]+' | tail -1 || true)
[ -n "${CYCLES:-}" ] || write_blocked \
    "Verilator run produced no cycle count (SUCCESS line missing)" \
    "completed Variane_testharness run" "inspect ${RUNLOG}"

INSNS=$(grep -cE '^core +0:' "${DASM}" 2>/dev/null || echo 0)
CPD=$(python3 -c "print(round(${CYCLES}/${RUNS}, 4))")
DMIPS=$(python3 -c "print(round((1e6/(${CYCLES}/${RUNS}))/1757, 4))")
CPI=$(python3 -c "print(round(${CYCLES}/${INSNS}, 4) if ${INSNS} else 'null')")

cat > "${EVIDENCE}" <<EOF
{
  "schema": "eliza.cpu_benchmark_measured.v1",
  "benchmark": "dhrystone",
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
    "gcc": "$("${GCC}" -dumpversion) (xpack riscv-none-elf)"
  },
  "dmips_per_mhz_formula": "(1e6 / cycles_per_dhrystone) / 1757",
  "metrics": {
    "total_cycles": ${CYCLES},
    "retired_instructions": ${INSNS},
    "cpi": ${CPI},
    "dhrystone_runs": ${RUNS},
    "cycles_per_dhrystone": ${CPD},
    "dmips_per_mhz": ${DMIPS}
  },
  "run_command": "external/cva6/cva6/work-ver/Variane_testharness ${ELF}"
}
EOF

cat > "${RESULT_JSON}" <<EOF
{
  "schema": "eliza.cpu_benchmark_result.v1",
  "benchmark": "dhrystone",
  "status": "passed",
  "substrate": "cva6 verilator (cycle-accurate RTL, ${TARGET})",
  "claim_level": "L1_RTL_FULL_SOC",
  "result_recorded_at": "$(now)",
  "manifest": "benchmarks/cpu/dhrystone/manifest.json",
  "metrics": {"total_cycles": ${CYCLES}, "retired_instructions": ${INSNS}, "cpi": ${CPI}, "dhrystone_runs": ${RUNS}, "cycles_per_dhrystone": ${CPD}, "dmips_per_mhz": ${DMIPS}},
  "evidence": "docs/evidence/cpu_ap/cva6-dhrystone-verilator.json"
}
EOF

echo "STATUS: PASSED cpu.dhrystone (cva6 verilator)"
echo "  cycles=${CYCLES} insns=${INSNS} CPI=${CPI} runs=${RUNS} cyc/dhry=${CPD} DMIPS/MHz=${DMIPS}"
