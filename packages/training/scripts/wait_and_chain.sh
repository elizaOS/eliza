#!/usr/bin/env bash
# Wait for deslop PID then chain: caveman -> diversify.
# Each step deletes the prior intermediate after success.
set -euo pipefail
cd "$(dirname "$0")/.."

DESLOP_PID="${1:-}"
DATA="data/final"

if [[ -n "$DESLOP_PID" ]]; then
  echo "[chain] waiting for deslop pid=$DESLOP_PID"
  while kill -0 "$DESLOP_PID" 2>/dev/null; do
    sleep 30
  done
  echo "[chain] deslop done"
fi

if [[ ! -f "$DATA/train_deslopped.jsonl" ]]; then
  echo "[chain] error: $DATA/train_deslopped.jsonl missing"
  exit 1
fi

echo "[chain] caveman start $(date +%H:%M:%S)"
python3 scripts/transform_caveman_thoughts.py
echo "[chain] caveman done $(date +%H:%M:%S)"

echo "[chain] rm deslopped (caveman supersedes)"
rm -f "$DATA/train_deslopped.jsonl"

df -h /home | tail -1

echo "[chain] diversify start $(date +%H:%M:%S)"
python3 scripts/transform_ngram_diversify.py
echo "[chain] diversify done $(date +%H:%M:%S)"

echo "[chain] rm caveman (diversify supersedes)"
rm -f "$DATA/train_caveman.jsonl"

df -h /home | tail -1
ls -lh "$DATA"/
echo "[chain] all done"
