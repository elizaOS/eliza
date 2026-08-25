#!/usr/bin/env bash
# Compatibility driver for an external benchmark-compatible server.
#
#   1. Build scenarios from existing pre-synthesized files
#   2. Verify an operator-started benchmark-compatible server
#   3. Run drive_eliza.py to push scenarios through
#   4. Export captured trajectories to JSONL
#
# Outputs land in `~/.eliza/training-datasets/<date>/{task}_trajectories.jsonl`
# matching the canonical nubilio shape.
#
# Required env:
#   ELIZA_BENCH_URL — explicit URL of the operator-started server
#   ELIZA_BENCH_TOKEN — secret matching that server
#
# Optional env:
#   N_SCENARIOS=200000        # how many scenarios to drive
#   CONCURRENCY=4

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
N_SCENARIOS="${N_SCENARIOS:-1000}"
CONCURRENCY="${CONCURRENCY:-4}"
ELIZA_BENCH_TOKEN="${ELIZA_BENCH_TOKEN:?set ELIZA_BENCH_TOKEN for the running server}"
ELIZA_BENCH_URL="${ELIZA_BENCH_URL:?set ELIZA_BENCH_URL for the running server}"
RUN_MARKER="$(mktemp "${TMPDIR:-/tmp}/eliza-synth-run.XXXXXX")"

cleanup() {
    rm -f "$RUN_MARKER"
}
trap cleanup EXIT

export ELIZA_BENCH_TOKEN
echo "[synth] using ELIZA_BENCH_TOKEN=${ELIZA_BENCH_TOKEN:0:8}…"

# ---------- 1. Build scenarios ----------
echo "[synth] step 1/4: building scenarios"
SCENARIOS=$ROOT/scripts/synth/scenarios/all.jsonl
$ROOT/.venv/bin/python $ROOT/scripts/synth/build_scenarios.py \
    --max-per-source 50000 \
    --out "$SCENARIOS"

# ---------- 2. Verify server ----------
echo "[synth] step 2/4: checking benchmark server at $ELIZA_BENCH_URL"
if ! curl -sf -H "Authorization: Bearer $ELIZA_BENCH_TOKEN" \
        "$ELIZA_BENCH_URL/api/benchmark/health" > /dev/null 2>&1; then
    echo "[synth] benchmark-compatible server is not ready" >&2
    exit 2
fi

# ---------- 3. Drive scenarios ----------
echo "[synth] step 3/4: driving $N_SCENARIOS scenarios @ concurrency=$CONCURRENCY"
$ROOT/.venv/bin/python $ROOT/scripts/synth/drive_eliza.py \
    --scenarios "$SCENARIOS" \
    --base-url "$ELIZA_BENCH_URL" \
    --token "$ELIZA_BENCH_TOKEN" \
    --concurrency "$CONCURRENCY" \
    --max-scenarios "$N_SCENARIOS" \
    --shuffle

# ---------- 4. Export trajectories ----------
echo "[synth] step 4/4: triggering trajectory export"
curl -sf -X POST -H "Authorization: Bearer $ELIZA_BENCH_TOKEN" \
    "$ELIZA_BENCH_URL/api/benchmark/diagnostics" > /dev/null || true

# trajectory-export-cron flushes on a timer; give it a moment then list
sleep 5
TRAJ_DIR="$HOME/.eliza/training-datasets"
echo "[synth] trajectory output dir: $TRAJ_DIR"
if [ -d "$TRAJ_DIR" ]; then
    find "$TRAJ_DIR" -name "*.jsonl" -newer "$RUN_MARKER" 2>/dev/null \
        | xargs -I{} sh -c 'echo "  {}: $(wc -l < {})"' || true
fi

echo "[synth] done"
