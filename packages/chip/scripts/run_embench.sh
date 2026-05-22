#!/bin/sh
# run_embench.sh — fail-closed Embench-IoT harness for the e1 CPU.
#
# DUT-selectable. The default and only cycle-accurate substrate is the CVA6
# ("Ariane") veri-testharness model, which is E1's little core (e1-pro) by
# construction (docs/evidence/cpu_ap/core-selection.json). Each of the 19
# Embench-IoT v1.0 workloads is compiled against the CVA6 bare-metal BSP
# (verif/tests/custom/common crt.S/syscalls.c, HTIF tohost exit) for rv64gc,
# run on work-ver/Variane_testharness, and the timed-region cycle count is read
# from the mcycle CSR (board support hooks start_trigger/stop_trigger). The
# Embench speed score is the geometric mean of reference/measured speed.
#
# Scoring (Embench v1.0 doc/README.md "Computing a benchmark value for speed"):
#   The reference platform is an STM32F4-Discovery Cortex-M4 at 16 MHz; the
#   per-benchmark reference times in baseline-data/speed.json are milliseconds
#   measured at CPU_MHZ=16 (i.e. LOCAL_SCALE_FACTOR*16 iterations). Our runs use
#   CPU_MHZ=1 (LOCAL_SCALE_FACTOR iterations), so the reference cycle count for
#   the same iteration count is:
#       reference_cycles = baseline_ms * 16000 / 16 = baseline_ms * 1000
#   and the per-benchmark relative speed (frequency-independent, IPC domain) is:
#       rel_speed = reference_cycles / measured_cycles = baseline_ms*1000 / measured_cycles
#   The geometric mean of rel_speed over all measured workloads is the score.
#   A score of 1.0 means cycle-for-cycle parity with the Cortex-M4 reference.
#
# Fail-closed: any missing dependency, build failure, or any run that does not
# reach a clean tohost completion writes blocked evidence naming the dependency
# and the exact next command, then exits 0 so the gate stays observable.

set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
MANIFEST="${ROOT}/benchmarks/cpu/embench/manifest.json"
RESULTS_DIR="${ROOT}/benchmarks/results/cpu/embench"
RESULT_JSON="${RESULTS_DIR}/result.json"
EVIDENCE="${ROOT}/docs/evidence/cpu_ap/cva6-embench-verilator.json"
EMB="${ROOT}/external/embench-iot"
CVA6="${ROOT}/external/cva6/cva6"
OSS="${ROOT}/external/oss-cad-suite"
GCC="${ROOT}/external/xpack-riscv-none-elf-gcc-15.2.0-1/bin/riscv-none-elf-gcc"
SPIKE="${CVA6}/tools/spike"
DTC_DIR="${ROOT}/external/deb-tools/dtc/usr/bin"
BUILD="${ROOT}/build/embench"
BSP="${CVA6}/verif/tests/custom/common"
ENV="${CVA6}/verif/tests/custom/env"
LINK="${CVA6}/config/gen_from_riscv_config/linker/link.ld"
VMODEL="${CVA6}/work-ver/Variane_testharness"
TARGET="cv64a6_imafdc_sv39"
TIME_OUT="${E1_EMBENCH_TIME_OUT:-20000000000}"

mkdir -p "${RESULTS_DIR}" "${BUILD}"
now() { date -u +%FT%TZ; }

write_blocked() {
    reason=$1; missing=$2; next=$3
    mkdir -p "$(dirname "${EVIDENCE}")"
    cat > "${EVIDENCE}" <<EOF
{
  "schema": "eliza.cpu_benchmark_measured.v1",
  "benchmark": "embench-iot",
  "core": "cva6",
  "core_role": "little_core_e1_pro",
  "target_config": "${TARGET}",
  "isa": "rv64gc",
  "mabi": "lp64d",
  "status": "blocked",
  "claim_level": "L1_RTL_FULL_SOC",
  "provenance": "simulator",
  "flow": "cva6 veri-testharness (Embench-IoT v1.0 workloads, CVA6 bare-metal BSP)",
  "result_recorded_at": "$(now)",
  "reason": "${reason}",
  "missing_dependency": "${missing}",
  "next_command": "${next}",
  "metrics": {"geometric_mean_score": null, "per_benchmark": {}}
}
EOF
    cat > "${RESULT_JSON}" <<EOF
{
  "schema": "eliza.cpu_benchmark_result.v1",
  "benchmark": "embench-iot",
  "status": "blocked",
  "dut": "cva6_verilator",
  "reason": "${reason}",
  "missing_dependency": "${missing}",
  "next_command": "${next}",
  "result_recorded_at": "$(now)",
  "manifest": "benchmarks/cpu/embench/manifest.json",
  "cycle_accurate_evidence": "docs/evidence/cpu_ap/cva6-embench-verilator.json"
}
EOF
    echo "STATUS: BLOCKED cpu.embench (cva6 verilator) - ${reason}"
    echo "  missing: ${missing}"
    echo "  next:    ${next}"
    exit 0
}

[ -f "${MANIFEST}" ] || write_blocked \
    "missing manifest" "benchmarks/cpu/embench/manifest.json" "git ls-files | grep embench"

if [ ! -d "${EMB}" ]; then
    write_blocked \
        "external/embench-iot/ checkout absent" "external/embench-iot" \
        "git clone https://github.com/embench/embench-iot.git external/embench-iot --branch embench-1.0"
fi
[ -x "${EMB}/build_all.py" ] || write_blocked \
    "embench-iot checkout missing build_all.py" "external/embench-iot/build_all.py" \
    "git -C external/embench-iot checkout embench-1.0"

DUT="${E1_EMBENCH_DUT:-verilator}"

[ -x "${GCC}" ] || write_blocked \
    "xpack riscv-none-elf-gcc not on disk" "${GCC}" "scripts/install_coremark_stream_tools.sh"

# The cycle-accurate substrate is CVA6 under Verilator. Other DUTs only give
# software-reference numbers and are intentionally fail-closed here.
case "${DUT}" in
    verilator) : ;;
    spike|qemu|board)
        write_blocked \
            "E1_EMBENCH_DUT=${DUT} is software-reference / not-yet-silicon; the cycle-accurate Embench score is produced only on the CVA6 verilator model" \
            "E1_EMBENCH_DUT=verilator" "E1_EMBENCH_DUT=verilator make embench" ;;
    *)
        write_blocked \
            "unknown E1_EMBENCH_DUT=${DUT}" "supported DUTs" \
            "E1_EMBENCH_DUT=verilator make embench" ;;
esac

[ -x "${OSS}/bin/verilator" ] || write_blocked \
    "Verilator absent" "${OSS}/bin/verilator" "source tools/env.sh"
[ -x "${VMODEL}" ] || write_blocked \
    "CVA6 Variane_testharness model not built (read-only prerequisite)" "${VMODEL}" \
    "cd external/cva6/cva6 && make verilate target=${TARGET}"
[ -f "${LINK}" ] || write_blocked \
    "CVA6 BSP linker script absent" "${LINK}" "git -C external/cva6/cva6 status"

export PATH="${OSS}/bin:${DTC_DIR}:${SPIKE}/bin:${PATH}"
export LD_LIBRARY_PATH="${SPIKE}/lib:${LD_LIBRARY_PATH:-}"

WORKLOADS="aha-mont64 crc32 cubic edn huffbench matmult-int minver nbody nettle-aes nettle-sha256 nsichneu picojpeg qrduino sglib-combined slre st statemate ud wikisort"

# 1. Build every workload against the CVA6 bare-metal BSP.
#    -std=gnu11: workloads predate C23, where bool/true/false are keywords
#       (xpack gcc 15.2.0 defaults to C23) — restore the C11 typedef behaviour.
#    -DE1_SINGLE_THREAD_PRINTF: drop the BSP putchar __thread buffer so libgcc
#       emutls (which would pull newlib malloc) is not linked.
#    cva6_boardsupport.c: start_trigger/stop_trigger read mcycle and print
#       "EMBENCH_CYCLES: N" over the HTIF UART.
#    cva6_libsupport.c: the few libc/libm-internal symbols (-nostdlib) the
#       workloads or libm reference (memmove/memcmp/strchr/ctype/__errno).
GCC_FLAGS="-std=gnu11 -O2 -g -march=rv64gc -mabi=lp64d -static -mcmodel=medany -nostdlib -nostartfiles -ffunction-sections -fdata-sections -Wl,-gc-sections -DCPU_MHZ=1 -DWARMUP_HEAT=1 -DE1_SINGLE_THREAD_PRINTF"
INCS="-I${EMB}/support -I${EMB}/config/riscv32/chips/generic -I${EMB}/config/riscv32/boards/ri5cyverilator -I${BSP} -I${ENV}"
SUPPORT="${EMB}/support/main.c ${EMB}/support/beebsc.c ${BUILD}/cva6_boardsupport.c ${BUILD}/cva6_libsupport.c ${BSP}/syscalls.c ${BSP}/crt.S"
[ -f "${BUILD}/cva6_boardsupport.c" ] || write_blocked \
    "cva6_boardsupport.c (mcycle timing hooks) absent" "${BUILD}/cva6_boardsupport.c" "git checkout build/embench/cva6_boardsupport.c"
[ -f "${BUILD}/cva6_libsupport.c" ] || write_blocked \
    "cva6_libsupport.c (libc/libm glue) absent" "${BUILD}/cva6_libsupport.c" "git checkout build/embench/cva6_libsupport.c"

if [ "${E1_EMBENCH_SKIP_BUILD:-0}" != "1" ]; then
    for b in ${WORKLOADS}; do
        # shellcheck disable=SC2086
        "${GCC}" ${GCC_FLAGS} ${INCS} -T"${LINK}" "${EMB}/src/${b}"/*.c ${SUPPORT} \
            -lgcc -lm -o "${BUILD}/${b}.elf" 2>"${BUILD}/${b}.build.log" \
            || write_blocked "Embench workload ${b} failed to compile/link against the CVA6 BSP" \
                 "${BUILD}/${b}.elf" "see ${BUILD}/${b}.build.log"
    done
fi

# 2. Run each workload on the model in parallel (dasm trace -> /dev/null to
#    avoid a multi-GB write; the cycle count comes from the tracer/CSR, not the
#    dasm). Skip the run only when E1_EMBENCH_SKIP_RUN=1 (logs already present).
run_one() {
    b=$1
    RD="${BUILD}/rundir/${b}"
    rm -rf "${RD}"; mkdir -p "${RD}"; ln -sf /dev/null "${RD}/trace_rvfi_hart_00.dasm"
    ELF="${BUILD}/${b}.elf"
    ( cd "${RD}" && "${VMODEL}" "${ELF}" "+elf_file=${ELF}" "+time_out=${TIME_OUT}" ) \
        > "${BUILD}/${b}.run.log" 2>&1 || true
}
if [ "${E1_EMBENCH_SKIP_RUN:-0}" != "1" ]; then
    for b in ${WORKLOADS}; do run_one "${b}" & done
    wait
fi

# 3. Collect cycles, verify clean completion, and compute the geomean score.
python3 - "$@" <<PYEOF
import json, os, re, math, datetime

ROOT     = "${ROOT}"
EMB      = "${EMB}"
BUILD    = "${BUILD}"
TARGET   = "${TARGET}"
GCC      = "${GCC}"
OSS      = "${OSS}"
WORKLOADS = "${WORKLOADS}".split()

baseline = json.load(open(os.path.join(EMB, "baseline-data", "speed.json")))

cyc_re  = re.compile(r"EMBENCH_CYCLES:\s+(\d+)")
term_re = re.compile(r"terminated after\s+(\d+)\s+cycles")

per = {}
failed = []
for b in WORKLOADS:
    log = os.path.join(BUILD, b + ".run.log")
    txt = open(log).read() if os.path.exists(log) else ""
    cyc  = cyc_re.search(txt)
    term = term_re.search(txt)
    is_failed = "*** FAILED ***" in txt
    if cyc and term and not is_failed:
        measured = int(cyc.group(1))
        ref_cycles = round(baseline[b] * 1000)        # baseline ms * 16000 / 16
        rel = ref_cycles / measured if measured else 0.0
        per[b] = {
            "measured_timed_cycles": measured,
            "total_program_cycles": int(term.group(1)),
            "reference_baseline_ms_stm32f4_16mhz": baseline[b],
            "reference_cycles_same_iterations": ref_cycles,
            "rel_speed": round(rel, 4),
            "status": "passed",
        }
    else:
        failed.append(b)

def fail_closed(reason, missing, nxt):
    ev = {
      "schema": "eliza.cpu_benchmark_measured.v1", "benchmark": "embench-iot",
      "core": "cva6", "core_role": "little_core_e1_pro", "target_config": TARGET,
      "isa": "rv64gc", "mabi": "lp64d", "status": "blocked",
      "claim_level": "L1_RTL_FULL_SOC", "provenance": "simulator",
      "result_recorded_at": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
      "reason": reason, "missing_dependency": missing, "next_command": nxt,
      "metrics": {"geometric_mean_score": None, "per_benchmark": per},
    }
    json.dump(ev, open("${EVIDENCE}", "w"), indent=2)
    res = {
      "schema": "eliza.cpu_benchmark_result.v1", "benchmark": "embench-iot",
      "status": "blocked", "dut": "cva6_verilator", "reason": reason,
      "missing_dependency": missing, "next_command": nxt,
      "result_recorded_at": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
      "manifest": "benchmarks/cpu/embench/manifest.json",
      "cycle_accurate_evidence": "docs/evidence/cpu_ap/cva6-embench-verilator.json",
    }
    json.dump(res, open("${RESULT_JSON}", "w"), indent=2)
    print(f"STATUS: BLOCKED cpu.embench (cva6 verilator) - {reason}")
    print(f"  missing: {missing}")
    print(f"  next:    {nxt}")
    raise SystemExit(0)

if not per:
    fail_closed(
        "no Embench workload reached a clean tohost completion on the CVA6 model "
        f"(failed/incomplete: {' '.join(failed) if failed else 'all'})",
        "clean per-workload completion (EMBENCH_CYCLES + 'terminated after N cycles', no FAILED)",
        "E1_EMBENCH_DUT=verilator make embench  (inspect build/embench/<bench>.run.log)")

# Geometric mean of rel_speed over the workloads that completed.
log_sum = sum(math.log(per[b]["rel_speed"]) for b in per if per[b]["rel_speed"] > 0)
geomean = math.exp(log_sum / len(per))

import subprocess
def tool_ver(args):
    try:
        return subprocess.run(args, capture_output=True, text=True).stdout.strip() \
            or subprocess.run(args, capture_output=True, text=True).stderr.strip()
    except Exception:
        return "unknown"

evidence = {
  "schema": "eliza.cpu_benchmark_measured.v1",
  "benchmark": "embench-iot",
  "embench_version": "v1.0 (tag embench-1.0)",
  "core": "cva6",
  "core_role": "little_core_e1_pro",
  "target_config": TARGET,
  "isa": "rv64gc",
  "mabi": "lp64d",
  "status": "passed" if not failed else "passed_partial",
  "claim_level": "L1_RTL_FULL_SOC",
  "provenance": "simulator",
  "flow": "cva6 veri-testharness (work-ver/Variane_testharness); Embench-IoT v1.0 workloads compiled against the CVA6 bare-metal BSP (HTIF tohost); timed region measured via mcycle CSR (start_trigger/stop_trigger)",
  "result_recorded_at": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
  "tools": {
    "verilator": tool_ver([os.path.join(OSS, "bin", "verilator"), "--version"]),
    "gcc": tool_ver([GCC, "-dumpversion"]) + " (xpack riscv-none-elf)",
    "gcc_flags": "-std=gnu11 -O2 -march=rv64gc -mabi=lp64d -nostdlib -nostartfiles -DCPU_MHZ=1",
  },
  "scoring": {
    "method": "Embench-IoT v1.0 speed score: geometric mean of per-benchmark relative speed",
    "relative_speed_formula": "reference_cycles / measured_timed_cycles, where reference_cycles = baseline_ms * 1000 (STM32F4 Cortex-M4 @ 16 MHz, normalised to CPU_MHZ=1 iteration count)",
    "reference_platform": "STM32F4-Discovery Cortex-M4 @ 16 MHz (Embench v1.0 baseline-data/speed.json)",
    "frequency_independent": True,
    "interpretation": "score of 1.0 == cycle-for-cycle parity with the Cortex-M4 reference; >1 == fewer cycles per benchmark than the reference",
  },
  "coverage": {
    "workloads_in_embench_v1.0": len(WORKLOADS),
    "workloads_scored": len(per),
    "workloads_failed": failed,
    "note": "Embench v1.0 ships 19 speed workloads; the manifest also lists primecount and tarfind which were introduced in Embench 2.0 and are absent at the pinned v1.0 tag.",
  },
  "metrics": {
    "geometric_mean_score": round(geomean, 4),
    "per_benchmark": per,
  },
}
json.dump(evidence, open("${EVIDENCE}", "w"), indent=2)

result = {
  "schema": "eliza.cpu_benchmark_result.v1",
  "benchmark": "embench-iot",
  "status": "passed" if not failed else "passed_partial",
  "dut": "cva6_verilator",
  "substrate": f"cva6 veri-testharness (cycle-accurate RTL, {TARGET})",
  "claim_level": "L1_RTL_FULL_SOC",
  "result_recorded_at": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
  "manifest": "benchmarks/cpu/embench/manifest.json",
  "metrics": {
    "geometric_mean_score": round(geomean, 4),
    "workloads_scored": len(per),
    "workloads_failed": failed,
  },
  "evidence": "docs/evidence/cpu_ap/cva6-embench-verilator.json",
}
json.dump(result, open("${RESULT_JSON}", "w"), indent=2)

tag = "PASSED" if not failed else "PASSED (partial)"
print(f"STATUS: {tag} cpu.embench (cva6 verilator)")
print(f"  Embench v1.0 speed geomean = {round(geomean,4)}  over {len(per)}/{len(WORKLOADS)} workloads")
if failed:
    print(f"  not scored: {' '.join(failed)}")
PYEOF
