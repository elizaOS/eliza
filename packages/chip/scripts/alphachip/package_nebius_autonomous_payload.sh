#!/usr/bin/env sh
set -eu

# Builds a fully self-contained payload for an autonomous Nebius H200 run.
#
# Unlike package_nebius_payload.sh (which expects circuit_training and the plc
# binary to be re-fetched on the host), this archive bundles everything the box
# needs to build the image and train offline:
#   - scripts/alphachip            (orchestration + run scripts)
#   - external/circuit_training    (source tree, no .git)
#   - the lawful plc_wrapper_main   (build_container.sh consumes via PLC_WRAPPER_MAIN)
#   - the E1 soft-macro benchmark   (netlist + OpenROAD baseline placement + compare dir)
#
# The box has NAT egress only (private IP), so the payload avoids any reliance
# on the dead GCS bucket. circuit_training source ships in the archive.

REPO_DIR="$(CDPATH=; cd -- "$(dirname -- "$0")/../.." && pwd)"
BENCH_DIR="${ALPHACHIP_BENCH_DIR:?set ALPHACHIP_BENCH_DIR to the prepared e1 benchmark dir}"
CT_DIR="${CT_DIR:-$REPO_DIR/external/circuit_training}"
PLC_BIN="${PLC_WRAPPER_MAIN:-$CT_DIR/checkpoints/plc_wrapper_main}"
OUT_DIR="${ALPHACHIP_PAYLOAD_DIR:-$REPO_DIR/build/alphachip/nebius}"
OUT_TAR="${ALPHACHIP_PAYLOAD_TAR:-$OUT_DIR/e1_ppo_autonomous_payload.tar.gz}"

for f in e1_softmacro.pb.txt e1_softmacro.openroad.plc; do
    if [ ! -f "$BENCH_DIR/$f" ]; then
        echo "Missing benchmark file $BENCH_DIR/$f. Run prepare_e1_softmacro_benchmark.sh first." >&2
        exit 1
    fi
done

if [ ! -d "$CT_DIR/circuit_training" ]; then
    echo "Missing circuit_training source at $CT_DIR" >&2
    exit 1
fi

if [ ! -f "$PLC_BIN" ]; then
    echo "Missing lawful plc_wrapper_main at $PLC_BIN" >&2
    echo "Re-fetch per docs/toolchain/alphachip-checkpoint-blocker.md before packaging." >&2
    exit 1
fi
if ! file "$PLC_BIN" | grep -q 'ELF 64-bit'; then
    echo "plc_wrapper_main is not a Linux x86-64 ELF binary:" >&2
    file "$PLC_BIN" >&2
    exit 1
fi

mkdir -p "$OUT_DIR"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/payload"
# Scripts + circuit_training source + research notes (compare scripts read these).
tar -c \
    --exclude='__pycache__' \
    --exclude='*.pyc' \
    --exclude='.git' \
    -C "$REPO_DIR" \
        scripts/alphachip \
        external/circuit_training \
        research/alpha_chip_macro_placement \
    | tar -x -C "$STAGE/payload"

# Ensure the lawful plc binary is present at the path build_container.sh expects.
# The tarball-extracted copy is mode 555 (read-only), so clear it before
# re-copying to avoid a Permission-denied overwrite.
CKPT_DIR="$STAGE/payload/external/circuit_training/checkpoints"
mkdir -p "$CKPT_DIR"
rm -f "$CKPT_DIR/plc_wrapper_main"
cp "$PLC_BIN" "$CKPT_DIR/plc_wrapper_main"
chmod 555 "$CKPT_DIR/plc_wrapper_main"

# Benchmark: netlist + OpenROAD baseline placement + any prebuilt compare dir.
mkdir -p "$STAGE/payload/bench/e1_softmacro_full"
cp "$BENCH_DIR/e1_softmacro.pb.txt"      "$STAGE/payload/bench/e1_softmacro_full/"
cp "$BENCH_DIR/e1_softmacro.openroad.plc" "$STAGE/payload/bench/e1_softmacro_full/"
if [ -d "$BENCH_DIR/compare" ]; then
    cp -r "$BENCH_DIR/compare" "$STAGE/payload/bench/e1_softmacro_full/compare"
fi

PLC_SHA="$(sha256sum "$PLC_BIN" | awk '{print $1}')"
cat > "$STAGE/payload/PAYLOAD_MANIFEST.txt" <<EOF
E1 PPO autonomous payload
benchmark_source=$BENCH_DIR
plc_wrapper_main_sha256=$PLC_SHA
packaged_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF

tar -czf "$OUT_TAR" -C "$STAGE/payload" .

echo "$OUT_TAR"
echo "size: $(du -h "$OUT_TAR" | awk '{print $1}')" >&2
echo "plc_wrapper_main sha256: $PLC_SHA" >&2
