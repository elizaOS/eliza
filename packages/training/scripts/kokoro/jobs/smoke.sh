#!/usr/bin/env bash
# CI smoke: full pipeline, synthetic data, no GPU, no model weights.
#
#   bash scripts/kokoro/jobs/smoke.sh
#
# This is what `bun run test:kokoro-pipeline` and the periodic CI guard run.

set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
TMP_DIR="${KOKORO_SMOKE_DIR:-$(mktemp -d -t kokoro-smoke.XXXXXX)}"

bash "$HERE/run_finetune.sh" \
  --voice-name smoke_voice \
  --output-dir "$TMP_DIR" \
  --synthetic-smoke

echo "smoke OK: $TMP_DIR"
