#!/usr/bin/env bash
set -uo pipefail

# Runs ON the Nebius H200 box, invoked by cloud-init after the payload is
# extracted. Self-contained: builds the AlphaChip image from the bundled
# circuit_training source + lawful plc binary, runs the OpenROAD proxy
# baseline, trains PPO on GPU, re-runs the comparison, tars everything,
# uploads to the result bucket, and powers the box off.
#
# Required env (baked into cloud-init):
#   PAYLOAD_ROOT            extracted payload dir (contains scripts/alphachip)
#   PPO_BUCKET              s3 bucket name for results
#   NEBIUS_S3_ENDPOINT      https endpoint
#   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY  upload creds
# Optional training-shape env passes straight through to run_h200_payload.sh.

PAYLOAD_ROOT="${PAYLOAD_ROOT:-/root/e1-ppo/payload}"
RESULT_DIR="${RESULT_DIR:-/root/e1-ppo/result}"
LOG_FILE="${LOG_FILE:-$RESULT_DIR/job.log}"
S3="aws --endpoint-url ${NEBIUS_S3_ENDPOINT} s3"

mkdir -p "$RESULT_DIR"
exec > >(tee -a "$LOG_FILE") 2>&1

upload() {
    # Best-effort incremental status upload so progress is visible even if the
    # box dies mid-run. Intentionally tolerant: this is observability, not the
    # acceptance artifact.
    $S3 cp "$1" "s3://${PPO_BUCKET}/$2" || echo "[upload] WARN failed: $2"
}

echo "[job] start $(date -u +%FT%TZ) host=$(hostname)"
nvidia-smi || echo "[job] WARN nvidia-smi unavailable"
upload "$LOG_FILE" status/job.log.partial

STATUS="UNKNOWN"
finish() {
    echo "[job] STATUS=$STATUS end $(date -u +%FT%TZ)"
    echo "$STATUS" > "$RESULT_DIR/STATUS"

    # Bundle every artifact: compare JSONs, eval placement, training logs,
    # post-route PPA if produced. Fail-closed honesty: we upload whatever the
    # run actually produced, no fabrication.
    TAR="/root/e1-ppo/e1_ppo_result.tar.gz"
    tar -czf "$TAR" \
        -C "$PAYLOAD_ROOT" \
            bench \
            runs \
            research/alpha_chip_macro_placement/07_post_route_ppa \
        -C "$RESULT_DIR" \
            STATUS job.log \
        2>/dev/null || tar -czf "$TAR" -C "$RESULT_DIR" STATUS job.log
    $S3 cp "$TAR" "s3://${PPO_BUCKET}/result/e1_ppo_result.tar.gz" \
        || echo "[job] WARN result upload failed"
    $S3 cp "$LOG_FILE" "s3://${PPO_BUCKET}/result/job.log" || true
    echo "$STATUS" > /root/e1-ppo/DONE
    $S3 cp /root/e1-ppo/DONE "s3://${PPO_BUCKET}/result/DONE" || true
    echo "[job] uploaded results, powering off"
    sync
    poweroff || shutdown -h now || true
}
trap finish EXIT

cd "$PAYLOAD_ROOT"
chmod +x scripts/alphachip/*.sh 2>/dev/null || true

# Self-contained build: hand build_container.sh the bundled lawful plc binary
# so it never reaches for the dead GCS bucket.
export PLC_WRAPPER_MAIN="$PAYLOAD_ROOT/external/circuit_training/checkpoints/plc_wrapper_main"
export CT_DIR="$PAYLOAD_ROOT/external/circuit_training"
export ALPHACHIP_BENCH_DIR="$PAYLOAD_ROOT/bench/e1_softmacro_full"
export ALPHACHIP_RUN_DIR="$PAYLOAD_ROOT/runs/e1_softmacro_full_train"

# GPU-only training. No pretrained checkpoint (20-block TPU ckpt unavailable):
# train from random init. Do NOT set ALPHACHIP_DOWNLOAD_PRETRAINED.
export USE_GPU=True
export ALPHACHIP_POLICY_DIR=""

if bash scripts/alphachip/run_h200_payload.sh; then
    # Acceptance gate: the proxy comparison must have produced an AlphaChip
    # proxy JSON to compare against the OpenROAD baseline. Absent that, the run
    # is BLOCKED, not a success.
    if [ -f "$ALPHACHIP_BENCH_DIR/compare/alphachip_proxy.json" ] \
       && [ -f "$ALPHACHIP_BENCH_DIR/compare/openroad_proxy.json" ]; then
        STATUS="OK_PROXY"
    else
        STATUS="BLOCKED_NO_PROXY_COMPARISON"
    fi
else
    STATUS="FAILED_TRAINING"
fi

exit 0
