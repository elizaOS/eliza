#!/usr/bin/env bash
# Drives the full AI QA loop: capture → analyze → report.
#
# Two modes:
#   --static  (default) — boot scripts/ai-qa/static-stack.mjs (stub API + static
#                        dist serve). Does NOT need the live dev stack and so
#                        survives in-progress refactors that break `bun run
#                        build:web`.
#   --live              — defer to the upstream playwright-ui-live-stack.ts.
#                        Will hit the workspace build path; only use when
#                        `bun run --cwd packages/app build` succeeds cleanly.
#
# Env knobs:
#   AI_QA_ROUTE_FILTER      comma-separated route ids to limit capture
#   AI_QA_VIEWPORTS         comma list, default "desktop,mobile"
#   AI_QA_THEMES            comma list, default "light,dark"
#   AI_QA_RUN_ID            override run id (default: ISO timestamp)
#   AI_QA_CONCURRENCY       parallel analysis calls (default: 3)
#   AI_QA_SKIP_CAPTURE      "1" to skip capture and only re-analyze the latest run
#   AI_QA_SKIP_ANALYZE      "1" to skip analyze (capture-only mode)
#   ANTHROPIC_API_KEY       required for analyze pass

set -euo pipefail

MODE="static"
for arg in "$@"; do
  case "$arg" in
    --static) MODE="static" ;;
    --live)   MODE="live" ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

RUN_ID="${AI_QA_RUN_ID:-$(date -u +%Y-%m-%dT%H-%M-%SZ)}"
export AI_QA_RUN_ID="$RUN_ID"
RUN_DIR="$ROOT/reports/ai-qa/$RUN_ID"
mkdir -p "$RUN_DIR"

echo "[ai-qa] run id: $RUN_ID"
echo "[ai-qa] run dir: $RUN_DIR"
echo "[ai-qa] mode:    $MODE"

STATIC_STACK_PID=""
cleanup() {
  if [ -n "$STATIC_STACK_PID" ] && kill -0 "$STATIC_STACK_PID" 2>/dev/null; then
    echo "[ai-qa] stopping static stack pid=$STATIC_STACK_PID"
    kill -TERM "$STATIC_STACK_PID" 2>/dev/null || true
    sleep 1
    kill -KILL "$STATIC_STACK_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

if [ "${AI_QA_SKIP_CAPTURE:-0}" != "1" ]; then
  if [ "$MODE" = "static" ]; then
    rm -f "$ROOT/scripts/ai-qa/.static-stack.json"
    node "$ROOT/scripts/ai-qa/static-stack.mjs" > "$RUN_DIR/static-stack.log" 2>&1 &
    STATIC_STACK_PID=$!
    echo "[ai-qa] static stack starting pid=$STATIC_STACK_PID"
    # wait for the ports file
    for _ in $(seq 1 30); do
      if [ -f "$ROOT/scripts/ai-qa/.static-stack.json" ]; then break; fi
      sleep 1
    done
    if [ ! -f "$ROOT/scripts/ai-qa/.static-stack.json" ]; then
      echo "[ai-qa] static stack did not produce ports file; see $RUN_DIR/static-stack.log"
      exit 4
    fi
    AI_QA_API_PORT="$(grep '"api":' "$ROOT/scripts/ai-qa/.static-stack.json" | head -1 | grep -oE '[0-9]+')"
    AI_QA_UI_PORT="$(grep '"ui":' "$ROOT/scripts/ai-qa/.static-stack.json" | head -1 | grep -oE '[0-9]+')"
    echo "[ai-qa] static stack ready api=$AI_QA_API_PORT ui=$AI_QA_UI_PORT"
    export ELIZA_UI_SMOKE_PORT="$AI_QA_UI_PORT"
    export ELIZA_UI_SMOKE_API_PORT="$AI_QA_API_PORT"
    export ELIZA_UI_SMOKE_REUSE_SERVER=1
  fi

  echo "[ai-qa] starting capture"
  set +e
  AI_QA_RUN_ID="$RUN_ID" \
    bun run --cwd packages/app test:e2e -- ai-qa-capture.spec.ts \
      2>&1 | tee "$RUN_DIR/capture.log"
  CAP_EXIT=$?
  set -e
  echo "[ai-qa] capture exit=$CAP_EXIT (continuing to analysis regardless)"
fi

if [ "${AI_QA_SKIP_ANALYZE:-0}" != "1" ]; then
  echo "[ai-qa] starting analysis"
  node "$ROOT/scripts/ai-qa/analyze.mjs" --run-dir "$RUN_DIR" \
    2>&1 | tee "$RUN_DIR/analyze.log"
  echo "[ai-qa] building report"
  node "$ROOT/scripts/ai-qa/build-report.mjs" --run-dir "$RUN_DIR" \
    2>&1 | tee "$RUN_DIR/build-report.log"
fi

echo "[ai-qa] done. report: $RUN_DIR/report.md"
