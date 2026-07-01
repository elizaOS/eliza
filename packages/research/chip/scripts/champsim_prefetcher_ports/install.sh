#!/usr/bin/env bash
# Install the in-repo ChampSim 2024-12 prefetcher ports
# (berti, ipcp, bingo, bop, pythia) into external/ChampSim/prefetcher/
# and build a per-prefetcher variant binary under external/ChampSim/bin/.
#
# These ports faithfully reimplement each CRC-style drop-in against the
# ChampSim 2024-12 module API (champsim::modules::prefetcher,
# champsim::address). See:
#   docs/evidence/cache/champsim_external_prefetchers_report.json
# for per-port algorithmic scope and any documented deviations from the
# published reference implementations.
#
# Usage:
#   ./scripts/champsim_prefetcher_ports/install.sh
#   python3 scripts/champsim_sweep.py --mode prefetch \
#       --warmup 2000000 --sim 2000000 --commit-evidence

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PORTS_DIR="${REPO_ROOT}/scripts/champsim_prefetcher_ports"
CHAMPSIM_DIR="${REPO_ROOT}/external/ChampSim"

if [[ ! -d "${CHAMPSIM_DIR}" ]]; then
  echo "ChampSim source tree not found at ${CHAMPSIM_DIR}." >&2
  echo "Clone https://github.com/ChampSim/ChampSim first (commit 24cc41bb)." >&2
  exit 1
fi

mkdir -p "${CHAMPSIM_DIR}/build-configs"

for pf in berti ipcp bingo bop pythia; do
  dest="${CHAMPSIM_DIR}/prefetcher/${pf}"
  mkdir -p "${dest}"
  cp "${PORTS_DIR}/${pf}"/*.cc "${PORTS_DIR}/${pf}"/*.h "${dest}/"
  cp "${PORTS_DIR}/build-configs/pref_${pf}.json" "${CHAMPSIM_DIR}/build-configs/"
done

cd "${CHAMPSIM_DIR}"
for pf in berti ipcp bingo bop pythia; do
  cp "build-configs/pref_${pf}.json" champsim_config.json
  ./config.sh champsim_config.json
  make -j"$(nproc)"
done

echo "Built variant binaries:"
for bin in "${CHAMPSIM_DIR}/bin/champsim_pref_berti" \
           "${CHAMPSIM_DIR}/bin/champsim_pref_ipcp" \
           "${CHAMPSIM_DIR}/bin/champsim_pref_bingo" \
           "${CHAMPSIM_DIR}/bin/champsim_pref_bop" \
           "${CHAMPSIM_DIR}/bin/champsim_pref_pythia"; do
    [ -f "$bin" ] && basename "$bin"
done
