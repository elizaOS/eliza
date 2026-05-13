#!/usr/bin/env bash
# Snapshot helper (bench) — paths are examples only
set -euo pipefail
SRC="${1:-./data}"
DST="${2:-./snapshots}"
mkdir -p "$DST"
tar -cf "$DST/manual-$(date +%Y%m%d).tar" -C "$(dirname "$SRC")" "$(basename "$SRC")"
echo "done"
