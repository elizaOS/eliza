#!/usr/bin/env sh
set -eu

REPO_DIR="$(CDPATH=; cd -- "$(dirname -- "$0")/../.." && pwd)"
CT_DIR="${CT_DIR:-$REPO_DIR/external/circuit_training}"
IMAGE="${ALPHACHIP_IMAGE:-circuit_training:e1-r0.0.4}"
BENCH_DIR="${ALPHACHIP_BENCH_DIR:-/tmp/e1-alphachip/e1_softmacro}"
RUN_DIR="${ALPHACHIP_RUN_DIR:-/tmp/e1-alphachip/e1_softmacro_train}"
USE_GPU="${USE_GPU:-False}"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "Missing Docker image: $IMAGE" >&2
    exit 1
fi

mkdir -p "$RUN_DIR"

set -- --rm \
    -v "$CT_DIR:/workspace" \
    -v "$BENCH_DIR:/e1-bench:ro" \
    -v "$RUN_DIR:/e1-alphachip" \
    -v "$REPO_DIR/scripts/alphachip:/e1-scripts:ro" \
    -w /workspace

if [ "$USE_GPU" = "True" ] || [ "$USE_GPU" = "true" ] || [ "$USE_GPU" = "1" ]; then
    set -- "$@" --gpus all
fi

docker run "$@" \
    -e ROOT_DIR=/e1-alphachip/run_00 \
    -e SCRIPT_LOGS=/e1-alphachip/run_00 \
    -e NETLIST_FILE=/e1-bench/e1_softmacro.pb.txt \
    -e INIT_PLACEMENT=/e1-bench/e1_softmacro.openroad.plc \
    -e NUM_COLLECT_JOBS="${NUM_COLLECT_JOBS:-4}" \
    -e USE_GPU="$USE_GPU" \
    -e STD_CELL_PLACER_MODE=fd \
    -e SEQUENCE_LENGTH="${SEQUENCE_LENGTH:-64}" \
    -e TRAIN_ITERATIONS="${TRAIN_ITERATIONS:-10}" \
    -e EPISODES_PER_ITERATION="${EPISODES_PER_ITERATION:-16}" \
    -e PER_REPLICA_BATCH_SIZE="${PER_REPLICA_BATCH_SIZE:-16}" \
    "$IMAGE" bash /e1-scripts/ct_single_host_train.sh
