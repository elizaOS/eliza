#!/usr/bin/env bash
#
# Eliza Framework Benchmark Orchestrator (TypeScript runtime).
#
# Usage:
#   ./run.sh              # Run default scenarios
#   ./run.sh --all        # Run all scenarios
#   ./run.sh --compare    # Only run comparison (no benchmarks)
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESULTS_DIR="${SCRIPT_DIR}/results"

timestamp_ms() {
  local ts
  ts="$(date +%s%3N 2>/dev/null || true)"
  if [[ "${ts}" =~ ^[0-9]+$ ]]; then
    echo "${ts}"
  else
    date +%s000
  fi
}

TIMESTAMP="$(timestamp_ms)"

# ─── Color output ────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info() { echo -e "${BLUE}[INFO]${NC} $*"; }
ok()   { echo -e "${GREEN}[OK]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()  { echo -e "${RED}[ERROR]${NC} $*"; }

# ─── Flags ───────────────────────────────────────────────────────────────────

COMPARE_ONLY=false
BENCH_ARGS=""

for arg in "$@"; do
  case "$arg" in
    --ts-only|--py-only|--rs-only)
      err "Multi-runtime flags are obsolete; only the TypeScript benchmark runs."
      exit 1
      ;;
    --compare)  COMPARE_ONLY=true ;;
    --all)      BENCH_ARGS="--all" ;;
    --scenarios=*) BENCH_ARGS="$arg" ;;
  esac
done

mkdir -p "${RESULTS_DIR}"

# ─── TypeScript Benchmark ────────────────────────────────────────────────────

if ! $COMPARE_ONLY; then
  info "═══ TypeScript Benchmark ═══"

  TS_DIR="${SCRIPT_DIR}/typescript"
  TS_OUTPUT="${RESULTS_DIR}/typescript-${TIMESTAMP}.json"
  PACKAGES_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
  REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

  # Ensure root workspace deps are installed (required for workspace:* resolution)
  if ! (cd "${REPO_ROOT}" && bun -e "require('@elizaos/core')" 2>/dev/null); then
    info "Installing root workspace dependencies (required for @elizaos/core)..."
    cd "${REPO_ROOT}" && bun install
    cd "${SCRIPT_DIR}"
  fi

  # Ensure core is built
  if [ ! -f "${PACKAGES_ROOT}/core/dist/node/index.node.js" ]; then
    info "Building @elizaos/core..."
    cd "${REPO_ROOT}" && bun run build:core
    cd "${SCRIPT_DIR}"
  fi

  info "Running TypeScript benchmark..."
  cd "${REPO_ROOT}"
  if bun run "${TS_DIR}/src/bench.ts" ${BENCH_ARGS} --output="${TS_OUTPUT}"; then
    ok "TypeScript benchmark complete: ${TS_OUTPUT}"
  else
    warn "TypeScript benchmark failed (see errors above)"
  fi
  cd "${SCRIPT_DIR}"
  echo
fi

# ─── Comparison Report ───────────────────────────────────────────────────────

info "═══ Comparison Report ═══"

RESULT_COUNT=$(ls -1 "${RESULTS_DIR}"/*.json 2>/dev/null | wc -l | tr -d ' ')

if [ "${RESULT_COUNT}" -eq "0" ]; then
  warn "No result files found in ${RESULTS_DIR}"
  exit 0
fi

if command -v bun &>/dev/null; then
  bun run "${SCRIPT_DIR}/compare.ts" --dir="${RESULTS_DIR}"
else
  warn "Bun not found — cannot run comparison. Install Bun or run compare.ts manually."
fi

echo
ok "Benchmark session complete. Results in: ${RESULTS_DIR}/"
