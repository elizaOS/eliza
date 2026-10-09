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
RESULTS_DIR="${BENCHMARK_OUTPUT_ROOT:-$(cd "${SCRIPT_DIR}/../../.." && pwd)/test-results/benchmark-framework}"

TIMESTAMP="$(date +%s)-$$"
TS_OUTPUT="${RESULTS_DIR}/typescript-${TIMESTAMP}.json"
COMPARE_ONLY=false
BENCH_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --compare) COMPARE_ONLY=true ;;
    --output=*)
      TS_OUTPUT="${arg#--output=}"
      if [[ "$TS_OUTPUT" != /* ]]; then TS_OUTPUT="$PWD/$TS_OUTPUT"; fi
      RESULTS_DIR="$(dirname "$TS_OUTPUT")"
      ;;
    *) BENCH_ARGS+=("$arg") ;;
  esac
done

mkdir -p "${RESULTS_DIR}"

if ! $COMPARE_ONLY; then
  (cd "${SCRIPT_DIR}/typescript" && bun run src/bench.ts "${BENCH_ARGS[@]}" --output="${TS_OUTPUT}")
  echo "Benchmark complete: ${TS_OUTPUT}"
  bun run "${SCRIPT_DIR}/compare.ts" --file="${TS_OUTPUT}"
else
  bun run "${SCRIPT_DIR}/compare.ts" --dir="${RESULTS_DIR}"
fi
