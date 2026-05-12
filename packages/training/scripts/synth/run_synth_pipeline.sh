#!/usr/bin/env bash
# End-to-end synth-trajectory generation pipeline.
#
#   1. Build scenarios from existing pre-synthesized files
#   2. Start the eliza benchmark server in the background
#   3. Run drive_eliza.py to push scenarios through
#   4. Export captured trajectories to JSONL
#   5. Stop the server
#
# Outputs land in `~/.eliza/training-datasets/<date>/{task}_trajectories.jsonl`
# matching the canonical nubilio shape.
#
# Required env:
#   ELIZA_BENCH_TOKEN — random secret; must match the running server
#
# Optional env:
#   N_SCENARIOS=200000        # how many scenarios to drive
#   CONCURRENCY=4
#   ELIZA_BENCH_URL=http://localhost:7777
#   ELIZA_BENCH_PORT=7777

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
N_SCENARIOS="${N_SCENARIOS:-1000}"
CONCURRENCY="${CONCURRENCY:-4}"
ELIZA_BENCH_TOKEN="${ELIZA_BENCH_TOKEN:-$(openssl rand -hex 16)}"
ELIZA_BENCH_PORT="${ELIZA_BENCH_PORT:-7777}"
ELIZA_BENCH_URL="${ELIZA_BENCH_URL:-http://localhost:$ELIZA_BENCH_PORT}"

export ELIZA_BENCH_TOKEN
echo "[synth] using ELIZA_BENCH_TOKEN=${ELIZA_BENCH_TOKEN:0:8}…"

# ---------- 1. Build scenarios ----------
echo "[synth] step 1/4: building scenarios"
SCENARIOS=$ROOT/scripts/synth/scenarios/all.jsonl
$ROOT/.venv/bin/python $ROOT/scripts/synth/build_scenarios.py \
    --max-per-source 50000 \
    --out "$SCENARIOS"

# ---------- 2. Start eliza server ----------
echo "[synth] step 2/4: starting eliza benchmark server on port $ELIZA_BENCH_PORT"
ELIZA_DIR="$ROOT/../eliza"
if [ ! -d "$ELIZA_DIR/packages/app-core" ]; then
    echo "  error: eliza submodule not found at $ELIZA_DIR" >&2
    exit 2
fi
SERVER_LOG=/tmp/eliza-bench-server.log
ELIZA_BENCH_PORT=$ELIZA_BENCH_PORT \
ELIZA_BENCH_TOKEN=$ELIZA_BENCH_TOKEN \
    bun run --cwd "$ELIZA_DIR/packages/app-core" \
        src/benchmark/server.ts \
    > "$SERVER_LOG" 2>&1 &
SERVER_PID=$!
echo "  server PID=$SERVER_PID; log=$SERVER_LOG"

cleanup() {
    if kill -0 "$SERVER_PID" 2>/dev/null; then
        echo "[synth] stopping server PID=$SERVER_PID"
        kill "$SERVER_PID" 2>/dev/null || true
        wait "$SERVER_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT

# Wait for server to come up
echo "[synth] waiting for server health"
for i in $(seq 1 60); do
    if curl -sf -H "Authorization: Bearer $ELIZA_BENCH_TOKEN" \
            "$ELIZA_BENCH_URL/api/benchmark/health" > /dev/null 2>&1; then
        echo "  server ready (waited ${i}s)"
        break
    fi
    sleep 1
done
if ! curl -sf -H "Authorization: Bearer $ELIZA_BENCH_TOKEN" \
        "$ELIZA_BENCH_URL/api/benchmark/health" > /dev/null 2>&1; then
    echo "[synth] server failed to start; tail of log:"
    tail -30 "$SERVER_LOG"
    exit 1
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
    find "$TRAJ_DIR" -name "*.jsonl" -newer "$SERVER_LOG" 2>/dev/null \
        | xargs -I{} sh -c 'echo "  {}: $(wc -l < {})"' || true
fi

echo "[synth] done"
