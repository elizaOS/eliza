#!/usr/bin/env sh
set -eu

REPO_DIR="$(CDPATH=; cd -- "$(dirname -- "$0")/../.." && pwd)"
CT_DIR="${CT_DIR:-$REPO_DIR/external/circuit_training}"
IMAGE="${ALPHACHIP_IMAGE:-circuit_training:e1-r0.0.4}"
BENCH_DIR="${ALPHACHIP_BENCH_DIR:-/tmp/e1-alphachip/e1_softmacro}"
RUN_DIR="${ALPHACHIP_RUN_DIR:-/tmp/e1-alphachip/e1_softmacro_train}"
USE_GPU="${USE_GPU:-False}"
GPU_MODE="${ALPHACHIP_GPU_MODE:-docker}"
POLICY_DIR="${ALPHACHIP_POLICY_DIR:-}"

case "$BENCH_DIR" in
    /*) ;;
    *) BENCH_DIR="$REPO_DIR/$BENCH_DIR" ;;
esac
case "$RUN_DIR" in
    /*) ;;
    *) RUN_DIR="$REPO_DIR/$RUN_DIR" ;;
esac

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "Missing Docker image: $IMAGE" >&2
    exit 1
fi

mkdir -p "$RUN_DIR"

set -- --rm \
    --user "$(id -u):$(id -g)" \
    -v "$CT_DIR:/workspace" \
    -v "$BENCH_DIR:/e1-bench:ro" \
    -v "$RUN_DIR:/e1-alphachip" \
    -v "$REPO_DIR/scripts/alphachip:/e1-scripts:ro" \
    -w /workspace

if [ -n "$POLICY_DIR" ]; then
    case "$POLICY_DIR" in
        /*) ;;
        *) POLICY_DIR="$REPO_DIR/$POLICY_DIR" ;;
    esac
    if [ ! -d "$POLICY_DIR" ]; then
        echo "Missing AlphaChip policy directory: $POLICY_DIR" >&2
        exit 1
    fi
    set -- "$@" -v "$POLICY_DIR:/e1-policy:ro"
fi

if [ "$USE_GPU" = "True" ] || [ "$USE_GPU" = "true" ] || [ "$USE_GPU" = "1" ]; then
    if [ "$GPU_MODE" = "manual" ]; then
        set -- "$@" \
            --device /dev/nvidia0 \
            --device /dev/nvidiactl \
            --device /dev/nvidia-uvm \
            --device /dev/nvidia-uvm-tools \
            --device /dev/nvidia-modeset
        for lib in /lib/x86_64-linux-gnu/libcuda.so* /lib/x86_64-linux-gnu/libnvidia-ml.so*; do
            [ -e "$lib" ] && set -- "$@" -v "$lib:$lib:ro"
        done
    else
        set -- "$@" --gpus all
    fi
fi

docker run "$@" \
    -e ROOT_DIR=/e1-alphachip/run_00 \
    -e SCRIPT_LOGS=/e1-alphachip/run_00 \
    -e REVERB_PORT="${REVERB_PORT:-8008}" \
    -e NETLIST_FILE=/e1-bench/e1_softmacro.pb.txt \
    -e INIT_PLACEMENT=/e1-bench/e1_softmacro.openroad.plc \
    -e NUM_COLLECT_JOBS="${NUM_COLLECT_JOBS:-4}" \
    -e USE_GPU="$USE_GPU" \
    -e STD_CELL_PLACER_MODE=fd \
    -e SEQUENCE_LENGTH="${SEQUENCE_LENGTH:-257}" \
    -e TRAIN_ITERATIONS="${TRAIN_ITERATIONS:-10}" \
    -e EPISODES_PER_ITERATION="${EPISODES_PER_ITERATION:-16}" \
    -e PER_REPLICA_BATCH_SIZE="${PER_REPLICA_BATCH_SIZE:-16}" \
    -e RUN_EVAL="${RUN_EVAL:-True}" \
    -e EVAL_OUTPUT_DIR=/e1-alphachip/run_00/eval_output \
    -e GLOBAL_SEED="${GLOBAL_SEED:-111}" \
    -e OBS_MAX_NUM_NODES="${OBS_MAX_NUM_NODES:-512}" \
    -e OBS_MAX_NUM_EDGES="${OBS_MAX_NUM_EDGES:-8192}" \
    -e OBS_MAX_GRID_SIZE="${OBS_MAX_GRID_SIZE:-16}" \
    -e EXTRA_GIN_BINDINGS="${EXTRA_GIN_BINDINGS:-}" \
    -e POLICY_CHECKPOINT_DIR="${POLICY_CHECKPOINT_DIR:-${POLICY_DIR:+/e1-policy}}" \
    -e POLICY_SAVED_MODEL_DIR="${POLICY_SAVED_MODEL_DIR:-${POLICY_DIR:+/e1-policy}}" \
    -e CD_FINETUNE="${CD_FINETUNE:-False}" \
    "$IMAGE" bash /e1-scripts/ct_single_host_train.sh
