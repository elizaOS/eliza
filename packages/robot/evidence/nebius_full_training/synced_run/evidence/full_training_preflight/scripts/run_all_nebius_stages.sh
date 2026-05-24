#!/usr/bin/env bash
set -euo pipefail
PACKAGE_ROOT="${ELIZA_ROBOT_PACKAGE_ROOT:-/home/shaw/milady/eliza/packages/robot}"
cd "$PACKAGE_ROOT"
uv run eliza-robot-run-full-training-bundle --bundle-dir evidence/full_training_preflight --endpoint "${NEBIUS_S3_ENDPOINT:-https://storage.eu-north1.nebius.cloud}" --upload-uri "${NEBIUS_TRAINING_S3_URI:-}"
