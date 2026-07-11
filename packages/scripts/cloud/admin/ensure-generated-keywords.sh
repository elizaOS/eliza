#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${ELIZA_REPO_ROOT:-/opt/eliza}"
LOCK_FILE="${ELIZA_KEYWORD_LOCK_FILE:-$REPO_ROOT/.eliza-generate-keywords.lock}"
GENERATOR="$REPO_ROOT/packages/shared/scripts/generate-keywords.mjs"
OUTPUTS=(
  "$REPO_ROOT/packages/shared/src/i18n/generated/validation-keyword-data.ts"
  "$REPO_ROOT/packages/shared/src/i18n/generated/validation-keyword-data.js"
  "$REPO_ROOT/packages/core/src/i18n/generated/validation-keyword-data.ts"
)

exec 9>"$LOCK_FILE"
flock 9

missing=0
for output in "${OUTPUTS[@]}"; do
  if [[ ! -s "$output" ]]; then
    missing=1
    break
  fi
done

if [[ "$missing" -eq 1 ]]; then
  echo "[generated-keywords] regenerating missing outputs"
  node "$GENERATOR"
fi

for output in "${OUTPUTS[@]}"; do
  if [[ ! -s "$output" ]]; then
    echo "[generated-keywords] required output missing or empty: $output" >&2
    exit 1
  fi
done
