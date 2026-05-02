#!/usr/bin/env bash
#
# Eliza Framework Benchmark Orchestrator
#
# Builds and runs all three runtime benchmarks sequentially,
# then generates a comparison report.
#
# Usage:
#   ./run.sh              # Run default scenarios
#   ./run.sh --all        # Run all scenarios
#   ./run.sh --ts-only    # Run only TypeScript
#   ./run.sh --py-only    # Run only Python
#   ./run.sh --rs-only    # Run only Rust
#   ./run.sh --compare    # Only run comparison (no benchmarks)
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESULTS_DIR="${SCRIPT_DIR}/results"
TIMESTAMP=$(date +%s%3N 2>/dev/null || date +%s000)

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

RUN_TS=true
RUN_PY=true
RUN_RS=true
COMPARE_ONLY=false
BENCH_ARGS=""

for arg in "$@"; do
  case "$arg" in
    --ts-only)  RUN_PY=false; RUN_RS=false ;;
    --py-only)  RUN_TS=false; RUN_RS=false ;;
    --rs-only)  RUN_TS=false; RUN_PY=false ;;
    --compare)  COMPARE_ONLY=true; RUN_TS=false; RUN_PY=false; RUN_RS=false ;;
    --all)      BENCH_ARGS="--all" ;;
    --scenarios=*) BENCH_ARGS="$arg" ;;
  esac
done

mkdir -p "${RESULTS_DIR}"

# ─── TypeScript Benchmark ────────────────────────────────────────────────────

if $RUN_TS && ! $COMPARE_ONLY; then
  info "═══ TypeScript Benchmark ═══"

  TS_DIR="${SCRIPT_DIR}/typescript"
  TS_OUTPUT="${RESULTS_DIR}/typescript-${TIMESTAMP}.json"
  REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

  # Ensure root workspace deps are installed (required for workspace:* resolution)
  if ! bun run -e "require('@elizaos/core')" 2>/dev/null; then
    info "Installing root workspace dependencies (required for @elizaos/core)..."
    cd "${REPO_ROOT}" && bun install
    cd "${SCRIPT_DIR}"
  fi

  # Ensure core is built
  if [ ! -f "${REPO_ROOT}/packages/typescript/dist/node/index.node.js" ]; then
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

# ─── Python Benchmark ────────────────────────────────────────────────────────

if $RUN_PY && ! $COMPARE_ONLY; then
  info "═══ Python Benchmark ═══"

  PY_DIR="${SCRIPT_DIR}/python"
  PY_OUTPUT="${RESULTS_DIR}/python-${TIMESTAMP}.json"

  # Check for Python
  if command -v python3 &>/dev/null; then
    PYTHON=python3
  elif command -v python &>/dev/null; then
    PYTHON=python
  else
    warn "Python not found, skipping Python benchmark"
    RUN_PY=false
  fi

  if $RUN_PY; then
    # Install dependencies if needed
    if ! $PYTHON -c "import elizaos" 2>/dev/null; then
      info "Installing Python dependencies..."
      cd "${PY_DIR}"
      $PYTHON -m pip install -e "${SCRIPT_DIR}/../../packages/python" 2>/dev/null || true
      $PYTHON -m pip install psutil 2>/dev/null || true
      cd "${SCRIPT_DIR}"
    fi

    info "Running Python benchmark..."
    cd "${PY_DIR}"
    if $PYTHON -m src.bench ${BENCH_ARGS} --output="${PY_OUTPUT}"; then
      ok "Python benchmark complete: ${PY_OUTPUT}"
    else
      warn "Python benchmark failed (see errors above)"
    fi
    cd "${SCRIPT_DIR}"
  fi
  echo
fi

# ─── Rust Benchmark ──────────────────────────────────────────────────────────

if $RUN_RS && ! $COMPARE_ONLY; then
  info "═══ Rust Benchmark ═══"

  RS_DIR="${SCRIPT_DIR}/rust"
  RS_OUTPUT="${RESULTS_DIR}/rust-${TIMESTAMP}.json"

  # Check for Cargo
  if ! command -v cargo &>/dev/null; then
    warn "Cargo not found, skipping Rust benchmark"
    RUN_RS=false
  fi

  if $RUN_RS; then
    info "Building Rust benchmark (release mode)..."
    cd "${RS_DIR}"
    if cargo build --release 2>&1; then
      info "Running Rust benchmark..."
      if ./target/release/bench ${BENCH_ARGS} --output="${RS_OUTPUT}"; then
        ok "Rust benchmark complete: ${RS_OUTPUT}"
      else
        warn "Rust benchmark failed (see errors above)"
      fi
    else
      warn "Rust build failed (see errors above)"
    fi
    cd "${SCRIPT_DIR}"
  fi
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
