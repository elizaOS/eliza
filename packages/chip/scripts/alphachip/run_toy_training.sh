#!/usr/bin/env sh
set -eu

REPO_DIR="$(CDPATH=; cd -- "$(dirname -- "$0")/../.." && pwd)"
CT_DIR="${CT_DIR:-$REPO_DIR/external/circuit_training}"
IMAGE="${ALPHACHIP_IMAGE:-circuit_training:e1-r0.0.4}"
RUN_DIR="${ALPHACHIP_RUN_DIR:-$REPO_DIR/build/alphachip/toy}"
USE_GPU="${USE_GPU:-False}"
REVERB_PORT="${REVERB_PORT:-8008}"
NUM_COLLECT_JOBS="${NUM_COLLECT_JOBS:-4}"
STD_CELL_PLACER_MODE="${STD_CELL_PLACER_MODE:-fd}"

NETLIST_FILE="${NETLIST_FILE:-./circuit_training/environment/test_data/toy_macro_stdcell/netlist.pb.txt}"
INIT_PLACEMENT="${INIT_PLACEMENT:-./circuit_training/environment/test_data/toy_macro_stdcell/initial.plc}"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "Missing Docker image: $IMAGE"
    echo "Build it with: scripts/alphachip/build_container.sh"
    exit 1
fi

if ! mkdir -p "$RUN_DIR" 2>/dev/null; then
    RUN_DIR="${TMPDIR:-/tmp}/e1-alphachip/toy"
    mkdir -p "$RUN_DIR"
    echo "Using writable temporary AlphaChip run directory: $RUN_DIR"
fi

set -- --rm -v "$CT_DIR:/workspace" -v "$RUN_DIR:/e1-alphachip" -v "$REPO_DIR/scripts/alphachip:/e1-scripts:ro" -w /workspace
if [ "$USE_GPU" = "True" ] || [ "$USE_GPU" = "true" ] || [ "$USE_GPU" = "1" ]; then
    set -- "$@" --gpus all
fi

docker run "$@" \
    -e ROOT_DIR=/e1-alphachip/run_00 \
    -e SCRIPT_LOGS=/e1-alphachip/run_00 \
    -e REVERB_PORT="$REVERB_PORT" \
    -e NETLIST_FILE="$NETLIST_FILE" \
    -e INIT_PLACEMENT="$INIT_PLACEMENT" \
    -e NUM_COLLECT_JOBS="$NUM_COLLECT_JOBS" \
    -e USE_GPU="$USE_GPU" \
    -e STD_CELL_PLACER_MODE="$STD_CELL_PLACER_MODE" \
    -e SEQUENCE_LENGTH=3 \
    "$IMAGE" bash /e1-scripts/ct_single_host_train.sh
