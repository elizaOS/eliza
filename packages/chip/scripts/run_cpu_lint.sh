#!/bin/sh
# run_cpu_lint.sh — Verilator strict lint on the OoO CPU tree.
#
# Lints each file the OoO domain owns under rtl/cpu/{cluster,csr,rvv,
# fusion}. Cross-domain packages (BPU, cache, interconnect) are included
# as headers only; their lint state is owned by the respective agent.
#
# Lint state baseline: WARN-clean for the OoO files, with the explicit
# `lint_off` waivers documented in each file. Any new warning is a
# regression and fails closed here.

set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
EVIDENCE_DIR="${ROOT}/build/evidence/cpu_ap"
RESULT_JSON="${EVIDENCE_DIR}/cpu-lint-result.json"
mkdir -p "${EVIDENCE_DIR}"

OSS_CAD="${ROOT}/external/oss-cad-suite/bin"
if [ -x "${OSS_CAD}/verilator" ]; then
    PATH="${OSS_CAD}:${PATH}"
    export PATH
fi

if ! command -v verilator >/dev/null 2>&1; then
    cat > "${RESULT_JSON}" <<EOF
{
  "schema": "eliza.cpu_lint_result.v1",
  "status": "blocked",
  "missing_dependency": "verilator on PATH or external/oss-cad-suite",
  "next_command": "source external/oss-cad-suite/environment",
  "result_recorded_at": "$(date -u +%FT%TZ)"
}
EOF
    echo "STATUS: BLOCKED cpu.lint - verilator not present"
    exit 0
fi

# File list and the `--top-module` to use for each. The cluster top
# implicitly links FTQ/L1D/AXI4 packages.
LINT_LOG="${EVIDENCE_DIR}/cpu-lint.log"
: > "${LINT_LOG}"
errors=0
warns=0

run_lint() {
    name=$1
    top=$2
    shift 2
    echo "=== ${name} (top=${top}) ===" >> "${LINT_LOG}"
    set +e
    verilator --lint-only -Wall -Wno-fatal -sv \
        -Irtl/cpu/bpu -Irtl/cpu/csr -Irtl/cpu/cluster -Irtl/cpu/rvv -Irtl/cpu/fusion \
        -Irtl/cache -Irtl/interconnect/axi4 \
        --top-module "${top}" \
        "$@" >> "${LINT_LOG}" 2>&1
    rc=$?
    set -e
    if [ "${rc}" -ne 0 ]; then
        errors=$((errors + 1))
    fi
}

cd "${ROOT}"

run_lint zihpm           zihpm           rtl/cpu/csr/zihpm.sv
run_lint ztso_ctrl       ztso_ctrl       rtl/cpu/csr/ztso_ctrl.sv
run_lint bpu_to_zihpm_remap bpu_to_zihpm_remap \
    rtl/cpu/bpu/bpu_pkg.sv rtl/cpu/csr/zihpm.sv rtl/cpu/csr/bpu_to_zihpm_remap.sv
run_lint rvv_csr         rvv_csr         rtl/cpu/rvv/rvv_csr.sv
run_lint rvv_unit_stub   rvv_unit_stub   rtl/cpu/rvv/rvv_csr.sv rtl/cpu/rvv/rvv_unit_stub.sv
run_lint rvv_alu_subset  rvv_alu_subset  rtl/cpu/rvv/rvv_csr.sv rtl/cpu/rvv/rvv_alu_subset.sv
run_lint e1_cluster_top  e1_cluster_top \
    rtl/interconnect/axi4/e1_axi4_pkg.sv \
    rtl/cache/ftq_to_l1i_pkg.sv \
    rtl/cache/lsu_to_l1d_pkg.sv \
    rtl/cpu/cluster/e1_cluster_top.sv

# Count "%Warning-" lines that originated in OoO-owned files. The
# `lint_off` filter excludes the waiver pragma echoes themselves so an
# active suppression does not register as a warning.
warns=$(awk '
    /^%Warning-/ && /rtl\/cpu\/(cluster|csr|rvv|fusion)\// && !/lint_off/ {
        count += 1
    }
    END {
        print count + 0
    }
' "${LINT_LOG}")

if [ "${errors}" -gt 0 ]; then
    status="fail"
elif [ "${warns}" -gt 0 ]; then
    status="warn"
else
    status="pass"
fi

cat > "${RESULT_JSON}" <<EOF
{
  "schema": "eliza.cpu_lint_result.v1",
  "status": "${status}",
  "verilator_errors": ${errors},
  "ooo_owned_warnings": ${warns},
  "log_path": "build/evidence/cpu_ap/cpu-lint.log",
  "result_recorded_at": "$(date -u +%FT%TZ)"
}
EOF

case "${status}" in
    pass) echo "STATUS: PASS cpu.lint - OoO files Verilator-clean";;
    warn) echo "STATUS: FAIL cpu.lint - ${warns} OoO-owned warnings (see ${LINT_LOG})"; exit 1;;
    fail) echo "STATUS: FAIL cpu.lint - ${errors} verilator errors (see ${LINT_LOG})"; exit 1;;
esac
