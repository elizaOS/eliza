#!/usr/bin/env bash
# Wrapper that drives the e1-demo FPGA flow end-to-end and archives logs.
#
# Steps: yosys synth -> nextpnr-ecp5 -> ecppack
# Archive: build/fpga/e1_demo/archive/<utc-timestamp>/
#
# This script does NOT program the board. Run `make -C board/fpga prog`
# (or invoke openFPGALoader directly) after inspecting the report.
#
# Requires OSS CAD Suite on PATH (yosys, nextpnr-ecp5, ecppack). Source
# scripts/env_oss_cad_suite.sh first if you have a vendored copy.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUILD_DIR="${REPO_ROOT}/build/fpga/e1_demo"
ARCHIVE_DIR="${BUILD_DIR}/archive/$(date -u +%Y%m%dT%H%M%SZ)"

if [[ -d "${REPO_ROOT}/external/oss-cad-suite/bin" ]]; then
  export PATH="${REPO_ROOT}/external/oss-cad-suite/bin:${PATH}"
fi

log() { printf '[build_e1_demo] %s\n' "$*"; }

archive_artifacts() {
  local status="$1"

  # Archive logs and intermediate outputs even on failed feasibility probes.
  for f in yosys.log nextpnr.log ecppack.log report.txt e1_chip_top.json e1_chip_top.config e1_chip_top.bit; do
    if [[ -f "${BUILD_DIR}/${f}" ]]; then
      cp "${BUILD_DIR}/${f}" "${ARCHIVE_DIR}/"
    fi
  done

  {
    echo "release_credit: false"
    echo "claim_boundary: non-release FPGA build probe; final board revision, final LPF, timing closure, route, pack, bitstream hash, and release review still required"
    echo "exit_status: ${status}"
    echo "git_rev: $(git -C "${REPO_ROOT}" rev-parse HEAD 2>/dev/null || echo unknown)"
    echo "git_branch: $(git -C "${REPO_ROOT}" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
    echo "host: $(uname -a)"
    echo "yosys: $(yosys -V 2>&1 | head -n 1)"
    echo "nextpnr: $(nextpnr-ecp5 --version 2>&1 | head -n 1)"
    echo "ecppack: $(ecppack --version 2>&1 | head -n 1)"
  } > "${ARCHIVE_DIR}/provenance.txt"
}

for tool in yosys nextpnr-ecp5 ecppack; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    log "ERROR: required tool '$tool' not on PATH"
    log "Hint: install OSS CAD Suite under external/oss-cad-suite or source scripts/env_oss_cad_suite.sh"
    exit 2
  fi
done

mkdir -p "${BUILD_DIR}" "${ARCHIVE_DIR}"
trap 'status=$?; archive_artifacts "$status"; exit "$status"' EXIT

log "build dir: ${BUILD_DIR}"
log "archive:   ${ARCHIVE_DIR}"

cd "${REPO_ROOT}"

log "running: make -C board/fpga synth"
make -C board/fpga synth

log "running: make -C board/fpga pnr"
make -C board/fpga pnr

log "running: make -C board/fpga pack"
make -C board/fpga pack

log "running: make -C board/fpga report"
make -C board/fpga report

log "done. artifacts: ${ARCHIVE_DIR}"
