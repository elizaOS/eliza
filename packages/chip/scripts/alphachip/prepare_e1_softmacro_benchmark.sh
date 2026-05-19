#!/usr/bin/env sh
set -eu

REPO_DIR="$(CDPATH=; cd -- "$(dirname -- "$0")/../.." && pwd)"
OUT_DIR="${ALPHACHIP_BENCH_DIR:-/tmp/e1-alphachip/e1_softmacro}"
SOURCE_DEF=""
COLS="${ALPHACHIP_SOFTMACRO_COLS:-8}"
ROWS="${ALPHACHIP_SOFTMACRO_ROWS:-8}"
AREA_SCALE="${ALPHACHIP_SOFTMACRO_AREA_SCALE:-0.08}"

usage() {
    cat <<'EOF'
Usage: scripts/alphachip/prepare_e1_softmacro_benchmark.sh [--def PATH] [--out-dir PATH]

Converts an OpenLane DEF to a Circuit Training protobuf, then collapses the
standard-cell placement into an E1 soft-macro placement benchmark.

If --def is omitted, the latest final DEF under pd/openlane/runs is used.
EOF
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --def)
            shift
            SOURCE_DEF="${1:-}"
            ;;
        --out-dir)
            shift
            OUT_DIR="${1:-}"
            ;;
        --cols)
            shift
            COLS="${1:-}"
            ;;
        --rows)
            shift
            ROWS="${1:-}"
            ;;
        --area-scale)
            shift
            AREA_SCALE="${1:-}"
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        *)
            echo "Unknown argument: $1" >&2
            usage >&2
            exit 2
            ;;
    esac
    shift
done

if [ -z "$SOURCE_DEF" ]; then
    SOURCE_DEF="$(find "$REPO_DIR/pd/openlane/runs" -path '*/final/def/*.def' -type f 2>/dev/null | sort | tail -1)"
fi
if [ -z "$SOURCE_DEF" ] || [ ! -f "$SOURCE_DEF" ]; then
    echo "No source DEF found. Run OpenLane first or pass --def." >&2
    exit 1
fi

mkdir -p "$OUT_DIR"
RAW_DIR="$OUT_DIR/raw"
mkdir -p "$RAW_DIR"

ALPHACHIP_OUT_DIR="$RAW_DIR" "$REPO_DIR/scripts/alphachip/convert_lefdef_to_pb.sh" --def "$SOURCE_DEF"
RAW_PB="$(find "$RAW_DIR" -maxdepth 1 -type f -name '*.pb.txt' | sort | tail -1)"
if [ -z "$RAW_PB" ]; then
    echo "No raw protobuf produced under $RAW_DIR" >&2
    exit 1
fi

"$REPO_DIR/scripts/alphachip/make_soft_macro_benchmark.py" \
    --pb "$RAW_PB" \
    --out-pb "$OUT_DIR/e1_softmacro.pb.txt" \
    --out-plc "$OUT_DIR/e1_softmacro.openroad.plc" \
    --cols "$COLS" \
    --rows "$ROWS" \
    --area-scale "$AREA_SCALE"

echo "Benchmark ready:"
echo "  source DEF: $SOURCE_DEF"
echo "  netlist: $OUT_DIR/e1_softmacro.pb.txt"
echo "  OpenROAD-derived placement: $OUT_DIR/e1_softmacro.openroad.plc"
