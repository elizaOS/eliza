#!/usr/bin/env bash
# Drives the full AI QA loop: capture → analyze → report.
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

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

RUN_ID="${AI_QA_RUN_ID:-$(date -u +%Y-%m-%dT%H-%M-%SZ)}"
export AI_QA_RUN_ID="$RUN_ID"
RUN_DIR="$ROOT/reports/ai-qa/$RUN_ID"
mkdir -p "$RUN_DIR"

echo "[ai-qa] run id: $RUN_ID"
echo "[ai-qa] run dir: $RUN_DIR"

if [ "${AI_QA_SKIP_CAPTURE:-0}" != "1" ]; then
  echo "[ai-qa] starting capture (this boots the live UI stack)"
  AI_QA_RUN_ID="$RUN_ID" \
    bun run --cwd packages/app test:e2e -- ai-qa-capture.spec.ts \
    || {
      echo "[ai-qa] capture spec exited non-zero — partial captures may exist in $RUN_DIR"
    }
fi

if [ "${AI_QA_SKIP_ANALYZE:-0}" != "1" ]; then
  echo "[ai-qa] starting analysis"
  node "$ROOT/scripts/ai-qa/analyze.mjs" --run-dir "$RUN_DIR"
  echo "[ai-qa] building report"
  node "$ROOT/scripts/ai-qa/build-report.mjs" --run-dir "$RUN_DIR"
fi

echo "[ai-qa] done. report: $RUN_DIR/report.md"
