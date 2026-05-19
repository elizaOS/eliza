#!/usr/bin/env sh
set -eu

REPO_DIR="$(CDPATH=; cd -- "$(dirname -- "$0")/../.." && pwd)"
CT_DIR="${CT_DIR:-$REPO_DIR/external/circuit_training}"
IMAGE="${ALPHACHIP_IMAGE:-circuit_training:e1-r0.0.4}"
BENCH_DIR="${ALPHACHIP_BENCH_DIR:-/tmp/e1-alphachip/e1_softmacro}"
OUT_DIR="${ALPHACHIP_COMPARE_DIR:-$BENCH_DIR/compare}"

if [ "$#" -gt 0 ]; then
    BENCH_DIR="$1"
fi

NETLIST="$BENCH_DIR/e1_softmacro.pb.txt"
OPENROAD_PLC="$BENCH_DIR/e1_softmacro.openroad.plc"
ALPHACHIP_PLC="${ALPHACHIP_PLC:-$BENCH_DIR/e1_softmacro.alphachip.plc}"

if [ ! -f "$NETLIST" ] || [ ! -f "$OPENROAD_PLC" ]; then
    echo "Missing benchmark files in $BENCH_DIR. Run prepare_e1_softmacro_benchmark.sh first." >&2
    exit 1
fi
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "Missing Docker image: $IMAGE" >&2
    exit 1
fi

mkdir -p "$OUT_DIR"

docker run --rm \
    --user "$(id -u):$(id -g)" \
    -v "$CT_DIR:/workspace" \
    -v "$REPO_DIR/scripts/alphachip:/e1-scripts:ro" \
    -v "$BENCH_DIR:/bench" \
    -v "$OUT_DIR:/compare" \
    -w /workspace \
    "$IMAGE" \
    python3.9 /e1-scripts/evaluate_plc.py \
        --netlist /bench/e1_softmacro.pb.txt \
        --plc /bench/e1_softmacro.openroad.plc \
        --out-json /compare/openroad_proxy.json

if [ -f "$ALPHACHIP_PLC" ]; then
    docker run --rm \
        --user "$(id -u):$(id -g)" \
        -v "$CT_DIR:/workspace" \
        -v "$REPO_DIR/scripts/alphachip:/e1-scripts:ro" \
        -v "$BENCH_DIR:/bench" \
        -v "$(dirname "$ALPHACHIP_PLC"):/alphachip-plc:ro" \
        -v "$OUT_DIR:/compare" \
        -w /workspace \
        "$IMAGE" \
        python3.9 /e1-scripts/evaluate_plc.py \
            --netlist /bench/e1_softmacro.pb.txt \
            --plc "/alphachip-plc/$(basename "$ALPHACHIP_PLC")" \
            --out-json /compare/alphachip_proxy.json
fi

echo "Proxy comparison artifacts:"
find "$OUT_DIR" -maxdepth 1 -type f -name '*_proxy.json' -print | sort
