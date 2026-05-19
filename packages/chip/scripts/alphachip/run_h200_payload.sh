#!/usr/bin/env sh
set -eu

PAYLOAD_DIR="$(CDPATH=; cd -- "$(dirname -- "$0")/../.." && pwd)"
CT_DIR="${CT_DIR:-$PAYLOAD_DIR/external/circuit_training}"
BENCH_DIR="${ALPHACHIP_BENCH_DIR:-$PAYLOAD_DIR/bench/e1_softmacro_full}"
RUN_DIR="${ALPHACHIP_RUN_DIR:-$PAYLOAD_DIR/runs/e1_softmacro_full_train}"
BASE_IMAGE="${ALPHACHIP_BASE_IMAGE:-circuit_training:e1-r0.0.4}"
IMAGE="${ALPHACHIP_IMAGE:-circuit_training:e1-r0.0.4-cuda-pip}"

mkdir -p "$PAYLOAD_DIR/external" "$BENCH_DIR" "$RUN_DIR"

if [ -f "$PAYLOAD_DIR/e1_softmacro.pb.txt" ] && [ ! -f "$BENCH_DIR/e1_softmacro.pb.txt" ]; then
    cp "$PAYLOAD_DIR/e1_softmacro.pb.txt" "$BENCH_DIR/e1_softmacro.pb.txt"
fi
if [ -f "$PAYLOAD_DIR/e1_softmacro.openroad.plc" ] && [ ! -f "$BENCH_DIR/e1_softmacro.openroad.plc" ]; then
    cp "$PAYLOAD_DIR/e1_softmacro.openroad.plc" "$BENCH_DIR/e1_softmacro.openroad.plc"
fi

if [ ! -d "$CT_DIR/.git" ]; then
    git clone https://github.com/google-research/circuit_training.git "$CT_DIR"
    git -C "$CT_DIR" checkout r0.0.4
fi

if ! docker image inspect "$BASE_IMAGE" >/dev/null 2>&1; then
    CT_DIR="$CT_DIR" ALPHACHIP_IMAGE="$BASE_IMAGE" \
        "$PAYLOAD_DIR/scripts/alphachip/build_container.sh"
fi

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    ALPHACHIP_BASE_IMAGE="$BASE_IMAGE" ALPHACHIP_IMAGE="$IMAGE" \
        "$PAYLOAD_DIR/scripts/alphachip/build_cuda_runtime_image.sh"
fi

if [ "${ALPHACHIP_DOWNLOAD_PRETRAINED:-0}" = "1" ] && [ ! -d "$PAYLOAD_DIR/tpu_checkpoint_20240815" ]; then
    "$PAYLOAD_DIR/scripts/alphachip/download_pretrained_checkpoint.sh" \
        "$PAYLOAD_DIR/tpu_checkpoint_20240815"
fi

ALPHACHIP_IMAGE="$IMAGE" \
ALPHACHIP_COMPARE_DIR="$BENCH_DIR/compare" \
    "$PAYLOAD_DIR/scripts/alphachip/compare_proxy_costs.sh" "$BENCH_DIR"

ALPHACHIP_IMAGE="$IMAGE" \
ALPHACHIP_BENCH_DIR="$BENCH_DIR" \
ALPHACHIP_RUN_DIR="$RUN_DIR" \
ALPHACHIP_POLICY_DIR="${ALPHACHIP_POLICY_DIR:-$PAYLOAD_DIR/tpu_checkpoint_20240815}" \
USE_GPU=True \
NUM_COLLECT_JOBS="${NUM_COLLECT_JOBS:-8}" \
SEQUENCE_LENGTH="${SEQUENCE_LENGTH:-257}" \
OBS_MAX_NUM_NODES="${OBS_MAX_NUM_NODES:-512}" \
OBS_MAX_NUM_EDGES="${OBS_MAX_NUM_EDGES:-8192}" \
OBS_MAX_GRID_SIZE="${OBS_MAX_GRID_SIZE:-16}" \
TRAIN_ITERATIONS="${TRAIN_ITERATIONS:-5}" \
EPISODES_PER_ITERATION="${EPISODES_PER_ITERATION:-16}" \
PER_REPLICA_BATCH_SIZE="${PER_REPLICA_BATCH_SIZE:-16}" \
    "$PAYLOAD_DIR/scripts/alphachip/run_e1_softmacro_training.sh"

ALPHACHIP_IMAGE="$IMAGE" \
ALPHACHIP_PLC="$RUN_DIR/run_00/eval_output/rl_opt_placement.plc" \
ALPHACHIP_COMPARE_DIR="$BENCH_DIR/compare" \
    "$PAYLOAD_DIR/scripts/alphachip/compare_proxy_costs.sh" "$BENCH_DIR"
