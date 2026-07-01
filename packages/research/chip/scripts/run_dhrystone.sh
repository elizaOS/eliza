#!/usr/bin/env bash
# run_dhrystone.sh — cycle-accurate Dhrystone on the CVA6 ("Ariane") reference
# core under Verilator, via CVA6's OWN supported veri-testharness flow. CVA6
# RV64GC is the open-core reference and E1's "little" core (e1-pro), so a
# measured DMIPS/MHz is both.
#
# Mirrors scripts/run_coremark_cva6_verilator.sh: reuse the prebuilt CVA6
# Verilator model, build the CVA6-bundled Dhrystone ELF with the supported
# verif/regress/dhrystone.sh flags, run to HTIF tohost completion, parse cycles
# from the RVFI tracer line and retired instructions from the RVFI dasm trace.
#
#   Dhrystone times its loop with read_csr(mcycle) and HZ=1e6 (dhrystone.h).
#   Its final "Microseconds for one run" line is therefore cycles per
#   Dhrystone at a 1 MHz reference clock:
#     cycles_per_dhrystone = microseconds_per_run
#     DMIPS/MHz            = dhrystones_per_second / 1757
#     CPI                 = total_cycles / retired_instructions
#
# The open corev_apu ariane_testharness includes an ITI/DPTI sideband trace
# pipe that can overflow on branch-dense Dhrystone. That trace pipe is not the
# RVFI dasm trace used for retired-instruction evidence, so this runner passes
# +e1_disable_iti_trace to disable only the sideband ITI/DPTI encoder while
# keeping the core, memory system, UART, tohost, and RVFI trace path intact.
#
# Fail-closed: any missing dependency, or any run that does not reach a clean
# Dhrystone completion, writes the blocked result naming the dep and the exact
# next command, then exits 0 so the gate is observable.
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
OSS="${ROOT}/external/oss-cad-suite"
GCC="${ROOT}/external/xpack-riscv-none-elf-gcc-15.2.0-1/bin/riscv-none-elf-gcc"
RISCV_TOOLCHAIN="${ROOT}/external/xpack-riscv-none-elf-gcc-15.2.0-1"
SPIKE="${CVA6}/tools/spike"
TARGET="cv64a6_imafdc_sv39"
mkdir -p "${RESULTS_DIR}"

now() { date -u +%FT%TZ; }

json_quote() {
    python3 -c 'import json, sys; print(json.dumps(sys.stdin.read()))'
}

write_blocked() {
    reason=$1; missing=$2; next=$3
    reason_json=$(printf '%s' "${reason}" | json_quote)
    missing_json=$(printf '%s' "${missing}" | json_quote)
    next_json=$(printf '%s' "${next}" | json_quote)
    cat > "${RESULT_JSON}" <<EOF
{
  "schema": "eliza.cpu_benchmark_result.v1",
  "benchmark": "dhrystone",
  "status": "blocked",
  "dut": "cva6_verilator",
  "reason": ${reason_json},
  "missing_dependency": ${missing_json},
  "next_command": ${next_json},
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
  "flow": "cva6 veri-testharness (verif/regress/dhrystone.sh build flags)",
  "dmips_per_mhz_formula": "(1e6 / cycles_per_dhrystone) / 1757",
  "result_recorded_at": "$(now)",
  "reason": ${reason_json},
  "missing_dependency": ${missing_json},
  "next_command": ${next_json},
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

have_read_elf() { [ -f "$1/lib/libfesvr.a" ] && nm "$1/lib/libfesvr.a" 2>/dev/null | grep -q " T .*read_elf"; }
have_read_elf "${SPIKE}" || write_blocked \
    "CVA6 pinned spike (libfesvr.a with read_elf) not built; the RVFI tracer needs it to resolve tohost from the ELF" \
    "${SPIKE}/lib/libfesvr.a (read_elf)" \
    "cd external/cva6/cva6 && PATH=external/deb-tools/dtc/usr/bin:\$PATH NUM_JOBS=\$(nproc) verif/regress/install-spike.sh"

export PATH="${OSS}/bin:${SPIKE}/bin:${PATH}"
export LD_LIBRARY_PATH="${SPIKE}/lib:${LD_LIBRARY_PATH:-}"
export RISCV="${RISCV:-${RISCV_TOOLCHAIN}}"
export VERILATOR_INSTALL_DIR="${VERILATOR_INSTALL_DIR:-${OSS}}"
NUM_JOBS=${NUM_JOBS:-$(nproc 2>/dev/null || echo 4)}
mkdir -p "${BUILD}"

VMODEL="${CVA6}/work-ver/Variane_testharness"
TB_SRC="${CVA6}/corev_apu/tb/ariane_testharness.sv"
if [ ! -x "${VMODEL}" ] || [ "${TB_SRC}" -nt "${VMODEL}" ]; then
    echo "[cva6-verilator] building model (target=${TARGET})..."
    ( cd "${CVA6}" && make verilate target="${TARGET}" verilator="verilator --no-timing" NUM_JOBS="${NUM_JOBS}" ) \
        || write_blocked "verilate failed" "external/cva6/cva6 verilate" \
            "cd external/cva6/cva6 && make verilate target=${TARGET}"
fi
[ -x "${VMODEL}" ] || write_blocked "Variane_testharness not produced" "${VMODEL}" \
    "cd external/cva6/cva6 && make verilate target=${TARGET}"

# Dhrystone ELF — build flags from verif/regress/dhrystone.sh, RV64GC.
DH="${CVA6}/verif/tests/custom/dhrystone"
BSP="${CVA6}/verif/tests/custom/common"
LINK="${CVA6}/config/gen_from_riscv_config/linker/link.ld"
ELF="${BUILD}/dhrystone.cva6.rv64gc.elf"
"${GCC}" -fno-tree-loop-distribute-patterns -static -mcmodel=medany -fvisibility=hidden \
    -nostdlib -nostartfiles -O3 --no-inline -march=rv64gc -mabi=lp64d \
    -Wno-implicit-function-declaration -Wno-implicit-int \
    -I"${CVA6}/verif/tests/custom/env" -I"${BSP}" -I"${DH}" -T"${LINK}" \
    "${DH}/dhrystone_main.c" "${DH}/dhrystone.c" "${BSP}/syscalls.c" "${BSP}/crt.S" \
    -DE1_SINGLE_THREAD_PRINTF -lgcc -o "${ELF}" \
    || write_blocked "Dhrystone ELF compile failed" "${ELF}" "see compiler output above"

RUNLOG="${BUILD}/dhrystone.cva6.run.log"
DASM="${CVA6}/trace_rvfi_hart_00.dasm"
rm -f "${DASM}"
( cd "${CVA6}" && "${VMODEL}" "${ELF}" "+elf_file=${ELF}" +e1_disable_iti_trace ) >"${RUNLOG}" 2>&1 || true

# A clean run needs the tracer's terminating cycle count AND a result banner.
CYCLES=$(grep -oE 'terminated after +[0-9]+ cycles' "${RUNLOG}" | grep -oE '[0-9]+' | tail -1 || true)
if [ -z "${CYCLES:-}" ] || ! grep -q "Dhrystones per Second" "${RUNLOG}"; then
    # Surface the precise failure mode (the encap-FIFO assertion is the known one).
    FAILLINE=$(grep -m1 -E "Fatal|Assertion|FAILED|fifo_v3" "${RUNLOG}" 2>/dev/null | tr -d '"' | cut -c1-200 || true)
    write_blocked \
        "CVA6 veri-testharness did not reach a clean Dhrystone completion. Observed: ${FAILLINE:-no result banner}. The run disables only the sideband ITI/DPTI trace path with +e1_disable_iti_trace; inspect ${RUNLOG} for the remaining core/testharness failure." \
        "clean Dhrystone completion under veri-testharness with RVFI trace" \
        "external/cva6/cva6/work-ver/Variane_testharness ${ELF} +elf_file=${ELF} +e1_disable_iti_trace"
fi

# (Reached only on a clean completion, e.g. a future patched testharness.)
prev_sz=-1; sz=$(wc -c < "${DASM}" 2>/dev/null || echo 0); tries=0
while [ "${sz}" != "${prev_sz}" ] && [ "${tries}" -lt 30 ]; do
    prev_sz="${sz}"; sleep 1; sync 2>/dev/null || true
    sz=$(wc -c < "${DASM}" 2>/dev/null || echo 0); tries=$((tries+1))
done
INSNS=$(LC_ALL=C grep -acE '^core +0:' "${DASM}" 2>/dev/null || echo 0)
RUNS=$(grep -oE '#define NUMBER_OF_RUNS[[:space:]]+[0-9]+' "${DH}/dhrystone.h" | grep -oE '[0-9]+' | tail -1 || true)
CPD=$(grep -oE 'Microseconds for one run through Dhrystone:[[:space:]]+[0-9]+' "${RUNLOG}" | grep -oE '[0-9]+' | tail -1 || true)
DPS=$(grep -oE 'Dhrystones per Second:[[:space:]]+[0-9]+' "${RUNLOG}" | grep -oE '[0-9]+' | tail -1 || true)
if [ -z "${RUNS:-}" ] || [ -z "${CPD:-}" ] || [ -z "${DPS:-}" ]; then
    write_blocked \
        "Dhrystone completed but final result metrics were not found on the UART" \
        "Dhrystone Microseconds/Dhrystones banner" "inspect ${RUNLOG}"
fi

DMIPS=$(python3 -c "print(round(${DPS}/1757, 4))")
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
  "flow": "cva6 veri-testharness (verif/regress/dhrystone.sh build flags)",
  "result_recorded_at": "$(now)",
  "tools": {
    "verilator": "$("${OSS}/bin/verilator" --version 2>&1)",
    "gcc": "$("${GCC}" -dumpversion) (xpack riscv-none-elf)"
  },
  "dmips_per_mhz_formula": "dhrystones_per_second / 1757; Dhrystone HZ=1e6 so microseconds_per_run equals cycles_per_dhrystone at 1 MHz",
  "metrics": {
    "total_cycles": ${CYCLES},
    "retired_instructions": ${INSNS},
    "cpi": ${CPI},
    "dhrystone_runs": ${RUNS},
    "cycles_per_dhrystone": ${CPD},
    "dhrystones_per_second": ${DPS},
    "dmips_per_mhz": ${DMIPS}
  },
  "run_command": "external/cva6/cva6/work-ver/Variane_testharness ${ELF} +elf_file=${ELF} +e1_disable_iti_trace"
}
EOF

cat > "${RESULT_JSON}" <<EOF
{
  "schema": "eliza.cpu_benchmark_result.v1",
  "benchmark": "dhrystone",
  "status": "passed",
  "dut": "cva6_verilator",
  "substrate": "cva6 veri-testharness (cycle-accurate RTL, ${TARGET})",
  "claim_level": "L1_RTL_FULL_SOC",
  "result_recorded_at": "$(now)",
  "manifest": "benchmarks/cpu/dhrystone/manifest.json",
  "metrics": {"total_cycles": ${CYCLES}, "retired_instructions": ${INSNS}, "cpi": ${CPI}, "dhrystone_runs": ${RUNS}, "cycles_per_dhrystone": ${CPD}, "dhrystones_per_second": ${DPS}, "dmips_per_mhz": ${DMIPS}},
  "evidence": "docs/evidence/cpu_ap/cva6-dhrystone-verilator.json"
}
EOF

echo "STATUS: PASSED cpu.dhrystone (cva6 verilator)"
echo "  cycles=${CYCLES} insns=${INSNS} CPI=${CPI} runs=${RUNS} cyc/dhry=${CPD} dhrystones/s=${DPS} DMIPS/MHz=${DMIPS}"
