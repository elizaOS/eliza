#!/usr/bin/env bash
set -euo pipefail

# Polls the result bucket for the DONE marker + result tarball, downloads them
# into build/alphachip/nebius_ppo_results/, and extracts.

export PATH="$HOME/.nebius/bin:$PATH"
CREDS="${PPO_CREDS:-/tmp/nebius_ppo_creds.env}"
set -a
# shellcheck disable=SC1090
. "$CREDS"
set +a

REPO_DIR="$(CDPATH=; cd -- "$(dirname -- "$0")/../.." && pwd)"
OUT="${RESULTS_DIR:-$REPO_DIR/build/alphachip/nebius_ppo_results}"
S3="aws --endpoint-url ${NEBIUS_S3_ENDPOINT} s3"
mkdir -p "$OUT"

if ! $S3 ls "s3://${PPO_BUCKET}/result/DONE" >/dev/null 2>&1; then
    echo "[fetch] DONE marker not present yet."
    $S3 cp "s3://${PPO_BUCKET}/status/job.log.partial" "$OUT/job.log.partial" 2>/dev/null \
        && echo "[fetch] pulled partial status log to $OUT/job.log.partial"
    exit 3
fi

$S3 cp "s3://${PPO_BUCKET}/result/DONE" "$OUT/DONE"
echo "[fetch] STATUS: $(cat "$OUT/DONE")"
$S3 cp "s3://${PPO_BUCKET}/result/e1_ppo_result.tar.gz" "$OUT/e1_ppo_result.tar.gz"
$S3 cp "s3://${PPO_BUCKET}/result/job.log" "$OUT/job.log" 2>/dev/null || true

tar -xzf "$OUT/e1_ppo_result.tar.gz" -C "$OUT"
echo "[fetch] extracted to $OUT"
find "$OUT" -name '*_proxy.json' -o -name '*.json' -path '*compare*' 2>/dev/null | sort
