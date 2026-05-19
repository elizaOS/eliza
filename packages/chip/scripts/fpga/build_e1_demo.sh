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

log() { printf '[build_e1_demo] %s\n' "$*"; }

for tool in yosys nextpnr-ecp5 ecppack; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    log "ERROR: required tool '$tool' not on PATH"
    log "Hint: source scripts/env_oss_cad_suite.sh or install OSS CAD Suite"
    exit 2
  fi
done

mkdir -p "${BUILD_DIR}" "${ARCHIVE_DIR}"

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

# Archive logs and the bitstream so a build can be reproduced.
for f in yosys.log nextpnr.log ecppack.log report.txt e1_chip_top.json e1_chip_top.config e1_chip_top.bit; do
  if [[ -f "${BUILD_DIR}/${f}" ]]; then
    cp "${BUILD_DIR}/${f}" "${ARCHIVE_DIR}/"
  fi
done

# Record the toolchain versions and git revision.
{
  echo "git_rev: $(git -C "${REPO_ROOT}" rev-parse HEAD 2>/dev/null || echo unknown)"
  echo "git_branch: $(git -C "${REPO_ROOT}" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
  echo "host: $(uname -a)"
  echo "yosys: $(yosys -V 2>&1 | head -n 1)"
  echo "nextpnr: $(nextpnr-ecp5 --version 2>&1 | head -n 1)"
  echo "ecppack: $(ecppack --version 2>&1 | head -n 1)"
} > "${ARCHIVE_DIR}/provenance.txt"

log "done. artifacts: ${ARCHIVE_DIR}"
