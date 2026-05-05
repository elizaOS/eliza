#!/usr/bin/env bash
set -euo pipefail

RUN_DIR=${1:-}
if [[ -z "$RUN_DIR" ]]; then
  if [[ ! -d runs ]]; then
    echo "no runs/ directory found" >&2
    exit 1
  fi
  RUN_DIR=$(ls -dt runs/* 2>/dev/null | head -n1 || true)
  if [[ -z "$RUN_DIR" ]]; then
    echo "no run directories found under runs/" >&2
    exit 1
  fi
fi

if [[ ! -f "$RUN_DIR/ws_stream.jsonl" ]]; then
  echo "missing ws_stream.jsonl in $RUN_DIR" >&2
  exit 1
fi

LINES=${LINES:-40}
tail -n "$LINES" "$RUN_DIR/ws_stream.jsonl"
