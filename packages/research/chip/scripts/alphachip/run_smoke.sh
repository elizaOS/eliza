#!/usr/bin/env sh
set -eu

REPO_DIR="$(CDPATH=; cd -- "$(dirname -- "$0")/../.." && pwd)"
CT_DIR="${CT_DIR:-$REPO_DIR/external/circuit_training}"
IMAGE="${ALPHACHIP_IMAGE:-circuit_training:e1-r0.0.4}"
RUN_DIR="${ALPHACHIP_RUN_DIR:-$REPO_DIR/build/alphachip/smoke}"
REVERB_PORT="${REVERB_PORT:-8008}"
NUM_COLLECT_JOBS="${NUM_COLLECT_JOBS:-4}"
USE_GPU="${USE_GPU:-False}"
STD_CELL_PLACER_MODE="${STD_CELL_PLACER_MODE:-fd}"

if [ ! -d "$CT_DIR/.git" ]; then
    echo "Missing Circuit Training checkout at $CT_DIR"
    exit 1
fi

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "Missing Docker image: $IMAGE"
    echo "Build it with: scripts/alphachip/build_container.sh"
    exit 1
fi

if ! mkdir -p "$RUN_DIR" 2>/dev/null; then
    RUN_DIR="${TMPDIR:-/tmp}/e1-alphachip/smoke"
    mkdir -p "$RUN_DIR"
    echo "Using writable temporary AlphaChip run directory: $RUN_DIR"
fi

set -- --rm -v "$CT_DIR:/workspace" -v "$RUN_DIR:/e1-alphachip" -v "$REPO_DIR/scripts/alphachip:/e1-scripts:ro" -w /workspace
if [ "$USE_GPU" = "True" ] || [ "$USE_GPU" = "true" ] || [ "$USE_GPU" = "1" ]; then
    set -- "$@" --gpus all
fi

echo "Running AlphaChip end-to-end smoke test."
echo "Logs and checkpoints: $RUN_DIR"
docker run "$@" \
    -e ROOT_DIR=/e1-alphachip/run_00 \
    -e SCRIPT_LOGS=/e1-alphachip/run_00 \
    -e REVERB_PORT="$REVERB_PORT" \
    -e NUM_COLLECT_JOBS="$NUM_COLLECT_JOBS" \
    -e USE_GPU="$USE_GPU" \
    -e STD_CELL_PLACER_MODE="$STD_CELL_PLACER_MODE" \
    -e NETLIST_FILE=./circuit_training/environment/test_data/ariane/netlist.pb.txt \
    -e INIT_PLACEMENT=./circuit_training/environment/test_data/ariane/initial.plc \
    -e SEQUENCE_LENGTH=134 \
    "$IMAGE" bash /e1-scripts/ct_single_host_train.sh
