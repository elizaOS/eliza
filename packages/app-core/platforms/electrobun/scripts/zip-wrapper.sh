#!/usr/bin/env bash
set -euo pipefail

REAL_ZIP="${ELECTROBUN_REAL_ZIP:-/usr/bin/zip}"

exec "$REAL_ZIP" -q "$@"
