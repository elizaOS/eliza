#!/usr/bin/env sh
set -eu

REPO_DIR="$(CDPATH=; cd -- "$(dirname -- "$0")/../.." && pwd)"
BENCH_DIR="${ALPHACHIP_BENCH_DIR:-/tmp/e1-alphachip/e1_softmacro_full}"
OUT_DIR="${ALPHACHIP_PAYLOAD_DIR:-$REPO_DIR/build/alphachip/nebius}"
OUT_TAR="${ALPHACHIP_PAYLOAD_TAR:-$OUT_DIR/e1_alphachip_payload.tar.gz}"

if [ "$#" -gt 0 ]; then
    BENCH_DIR="$1"
fi

if [ ! -f "$BENCH_DIR/e1_softmacro.pb.txt" ] || [ ! -f "$BENCH_DIR/e1_softmacro.openroad.plc" ]; then
    echo "Missing benchmark files in $BENCH_DIR. Run prepare_e1_softmacro_benchmark.sh first." >&2
    exit 1
fi

mkdir -p "$OUT_DIR"
tar -czf "$OUT_TAR" \
    --exclude='__pycache__' \
    --exclude='*.pyc' \
    -C "$REPO_DIR" \
        scripts/alphachip \
        research/alpha_chip_macro_placement \
    -C "$BENCH_DIR" \
        e1_softmacro.pb.txt \
        e1_softmacro.openroad.plc \
        compare

cat > "$OUT_DIR/README.txt" <<EOF
E1 AlphaChip payload

Benchmark source: $BENCH_DIR
Archive: $OUT_TAR

On the H200 host:

  mkdir -p ~/e1-alphachip/payload
  tar -xzf e1_alphachip_payload.tar.gz -C ~/e1-alphachip/payload

Use ~/e1-alphachip/payload as the repo root for scripts/alphachip, and copy or
symlink e1_softmacro.pb.txt and e1_softmacro.openroad.plc into a benchmark dir.
EOF

echo "$OUT_TAR"
