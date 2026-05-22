#!/bin/sh
# run_e1_rvv_vector.sh — fail-closed RVV 1.0 functional vector evaluation.
#
# Builds the autovec kernel suite twice (scalar rv64gc, vector rv64gcv) and
# runs both under QEMU user-mode on an RVV 1.0 substrate (rva23u64) with the
# VLEN set to E1's big-core target (256). Measures the *dynamic* instruction
# stream of each kernel via QEMU's execlog TCG plugin and writes
# docs/evidence/cpu_ap/e1-rvv-vector.json (schema eliza.cpu_vector_eval.v1).
#
# This establishes the VECTOR axis E1 targets (RVV 1.0) and that CVA6's base
# core lacks: it is a *functional* claim (ISA + toolchain execute end to end,
# with measured scalar-vs-vector dynamic instruction reduction), NOT a
# cycle-accurate or silicon performance claim. The cycle-accurate RTL path is
# tracked separately in docs/arch/rvv-integration-plan.md and the cocotb
# subset test under verify/cocotb/cpu.
#
# Every dependency failure writes the evidence file with status "blocked" and
# the command that will satisfy the gate, then exits 0 so CI stays observable.

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
AUTOVEC="${ROOT}/benchmarks/compiler/autovec"
BUILD_DIR="${ROOT}/build/reports/compiler/rvv-vector"
EVIDENCE="${ROOT}/docs/evidence/cpu_ap/e1-rvv-vector.json"

GCC="${ROOT}/external/xpack-riscv-none-elf-gcc-15.2.0-1/bin/riscv-none-elf-gcc"
OBJDUMP="${ROOT}/external/xpack-riscv-none-elf-gcc-15.2.0-1/bin/riscv-none-elf-objdump"
QEMU="${E1_RVV_QEMU:-${ROOT}/external/qemu-build/bin/qemu-riscv64}"
PLUGIN="${E1_RVV_PLUGIN:-${ROOT}/external/qemu-src/build/contrib/plugins/libexeclog.so}"
CPU="rva23u64,v=true,vlen=256"
VLEN=256

mkdir -p "$(dirname "${EVIDENCE}")"

write_blocked() {
    reason=$1
    missing_dep=$2
    next_command=$3
    cat > "${EVIDENCE}" <<EOF
{
  "schema": "eliza.cpu_vector_eval.v1",
  "status": "blocked",
  "substrate": "qemu-user",
  "rvv_version": "1.0",
  "vlen_bits": ${VLEN},
  "claim_level": "functional",
  "reason": "${reason}",
  "missing_dependency": "${missing_dep}",
  "next_command": "${next_command}",
  "generated_at": "$(date -u +%FT%TZ)"
}
EOF
    echo "STATUS: BLOCKED cpu_ap.rvv-vector - ${reason}"
    echo "  missing: ${missing_dep}"
    echo "  next:    ${next_command}"
    exit 0
}

[ -x "${GCC}" ] || write_blocked \
    "xpack riscv-none-elf-gcc absent" "${GCC}" \
    "install the xpack rv64 toolchain under external/"

"${GCC}" -march=rv64gcv -mabi=lp64d -x c -c /dev/null -o /dev/null 2>/dev/null \
    || write_blocked "gcc lacks rv64gcv (V extension) support" "${GCC} -march=rv64gcv" \
       "upgrade to a gcc that supports the ratified V extension"

[ -x "${QEMU}" ] || write_blocked \
    "qemu-riscv64 user-mode binary absent" "${QEMU}" \
    "build qemu user-mode (qemu-riscv64) or set E1_RVV_QEMU"

mkdir -p "${BUILD_DIR}"

# QEMU must accept the RVV 1.0 CPU + vlen override. Probe with a real rv64gcv
# ELF that issues a single vsetvli so a CPU lacking V fails the run.
PROBE_C="${BUILD_DIR}/.rvv_probe.c"
PROBE_ELF="${BUILD_DIR}/.rvv_probe.elf"
cat > "${PROBE_C}" <<'PROBE'
int main(void){ long vl; __asm__ volatile("vsetvli %0, zero, e32, m1, ta, ma":"=r"(vl)); return 0; }
PROBE
"${GCC}" -O0 -march=rv64gcv -mabi=lp64d "${PROBE_C}" -o "${PROBE_ELF}" 2>/dev/null \
    || write_blocked "probe build failed (rv64gcv)" "${GCC} -march=rv64gcv" \
       "verify the toolchain accepts inline RVV asm"
"${QEMU}" -cpu "${CPU}" "${PROBE_ELF}" >/dev/null 2>&1 \
    || write_blocked "qemu rejects RVV 1.0 cpu/vlen or traps vsetvli" "${CPU}" \
       "use a qemu build with rva23u64 + vlen override (>= 8.x)"

[ -x "${PLUGIN}" ] || [ -f "${PLUGIN}" ] || write_blocked \
    "qemu execlog TCG plugin absent" "${PLUGIN}" \
    "build qemu contrib plugins (make -C external/qemu-src/build contrib/plugins) or set E1_RVV_PLUGIN"

[ -f "${AUTOVEC}/driver.c" ] || write_blocked \
    "driver.c absent" "${AUTOVEC}/driver.c" "git -C ${ROOT} status benchmarks/compiler/autovec"
[ -f "${AUTOVEC}/kernels.c" ] || write_blocked \
    "kernels.c absent" "${AUTOVEC}/kernels.c" "git -C ${ROOT} status benchmarks/compiler/autovec"

PYTHON="${PYTHON:-python3}"

echo "RVV 1.0 functional vector eval: cpu=${CPU} compiler=$("${GCC}" -dumpversion)"

"${PYTHON}" "${AUTOVEC}/run_vector_eval.py" \
    --gcc "${GCC}" \
    --objdump "${OBJDUMP}" \
    --qemu "${QEMU}" \
    --plugin "${PLUGIN}" \
    --cpu "${CPU}" \
    --vlen "${VLEN}" \
    --driver "${AUTOVEC}/driver.c" \
    --kernels-c "${AUTOVEC}/kernels.c" \
    --kernels-json "${AUTOVEC}/kernels.json" \
    --build-dir "${BUILD_DIR}" \
    --out "${EVIDENCE}"

echo "STATUS: OK cpu_ap.rvv-vector - evidence at ${EVIDENCE}"
