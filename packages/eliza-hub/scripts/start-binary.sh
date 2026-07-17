#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="${ROOT}/bin/forgejo-15.0.3-linux-amd64"

exec "${BIN}" \
  --work-path "${ROOT}/binary-work" \
  --custom-path "${ROOT}/custom" \
  --config "${ROOT}/custom/conf/app.ini" \
  web
