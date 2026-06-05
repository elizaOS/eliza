#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'USAGE'
Usage: scripts/run_hian.sh [CASE_DIR] [-- <hl-runner args>]

Environment variables:
  OUT_DIR   Override run output directory (default: runs/hian-<timestamp>)

Examples:
  scripts/run_hian.sh
  OUT_DIR=runs/hian-demo scripts/run_hian.sh dataset/hian/case_128k -- --effect-timeout-ms 100
USAGE
  exit 0
fi

CASE_DIR=${1:-dataset/hian/case_128k}
if [[ $# -gt 0 ]]; then
  shift
fi
if [[ "${1:-}" == "--" ]]; then
  shift
fi

OUT_DIR=${OUT_DIR:-"runs/hian-$(date +%Y%m%d-%H%M%S)"}
PLAN_FILE="$OUT_DIR/hian_plan.json"
mkdir -p "$OUT_DIR"

cat > "$PLAN_FILE" <<'JSON'
{
  "steps": [
    { "usd_class_transfer": { "toPerp": true, "usdc": 7.5 } },
    {
      "perp_orders": {
        "orders": [
          {
            "coin": "ETH",
            "tif": "ALO",
            "side": "buy",
            "sz": 0.01,
            "reduceOnly": false,
            "px": "mid-1%"
          }
        ]
      }
    }
  ]
}
JSON

cargo run -p hl-runner -- \
  --plan "$PLAN_FILE" \
  --out "$OUT_DIR" \
  --network local \
  --demo \
  "$@"

cargo run -p hl-evaluator -- hian \
  --ground "$CASE_DIR/ground_truth.json" \
  --per-action "$OUT_DIR/per_action.jsonl" \
  --ws-stream "$OUT_DIR/ws_stream.jsonl" \
  --out-dir "$OUT_DIR"

cat "$OUT_DIR/eval_hian.json"
