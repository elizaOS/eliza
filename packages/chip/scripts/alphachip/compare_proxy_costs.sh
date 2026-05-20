#!/usr/bin/env sh
set -eu

REPO_DIR="$(CDPATH=; cd -- "$(dirname -- "$0")/../.." && pwd)"
CT_DIR="${CT_DIR:-$REPO_DIR/external/circuit_training}"
IMAGE="${ALPHACHIP_IMAGE:-circuit_training:e1-r0.0.4}"
BENCH_DIR="${ALPHACHIP_BENCH_DIR:-/tmp/e1-alphachip/e1_softmacro}"
OUT_DIR="${ALPHACHIP_COMPARE_DIR:-$BENCH_DIR/compare}"

# Optional post-route PPA truth knobs.
# When OPENROAD_RUN_DIR + OPENLANE_CONFIG are both set, the script calls
# scripts/run_post_route_ppa.py after the proxy step so the output directory
# carries both proxy AND PPA truth deltas.
OPENROAD_RUN_DIR="${OPENROAD_RUN_DIR:-}"
OPENLANE_CONFIG="${OPENLANE_CONFIG:-pd/openlane/config.sky130.json}"
SKIP_POST_ROUTE="${SKIP_POST_ROUTE:-0}"

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

mkdir -p "$OUT_DIR"

# Proxy step: requires circuit_training image. When the image is absent the
# proxy delta is skipped. If OPENROAD_RUN_DIR is set the script still proceeds
# to the post-route PPA truth capture below, which is the False-Dawn-honest
# final acceptance metric. A missing image without OPENROAD_RUN_DIR fails.
PROXY_RAN=0
if docker image inspect "$IMAGE" >/dev/null 2>&1; then
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
    PROXY_RAN=1

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
else
    if [ -z "$OPENROAD_RUN_DIR" ]; then
        echo "Missing Docker image: $IMAGE and no OPENROAD_RUN_DIR set; nothing to do." >&2
        echo "Either build the alphachip image (scripts/alphachip/build_container.sh) or" >&2
        echo "export OPENROAD_RUN_DIR=<pd/openlane/runs/RUN_...> to capture post-route PPA only." >&2
        exit 1
    fi
    echo "Missing Docker image: $IMAGE — skipping proxy step." >&2
    echo "Proceeding to post-route PPA capture only (OPENROAD_RUN_DIR=$OPENROAD_RUN_DIR)." >&2
fi

echo "Proxy comparison artifacts:"
if [ "$PROXY_RAN" -eq 1 ]; then
    find "$OUT_DIR" -maxdepth 1 -type f -name '*_proxy.json' -print | sort
else
    echo "  (skipped: $IMAGE not installed)"
fi

# DREAMPlace step (optional). Runs the limbo018/DREAMPlace v4 placer against a
# Bookshelf representation of the CT benchmark and emits an HPWL number that
# can be compared against the OpenROAD baseline and the AlphaChip RL output
# under one transparent wirelength metric.
DREAMPLACE_IMAGE="${DREAMPLACE_IMAGE:-limbo018/dreamplace:cuda}"
DREAMPLACE_REPO="${DREAMPLACE_REPO:-$REPO_DIR/external/DREAMPlace}"
RUN_DREAMPLACE="${RUN_DREAMPLACE:-1}"

if [ "$RUN_DREAMPLACE" = "1" ] && [ -d "$DREAMPLACE_REPO/install" ]; then
    BOOKSHELF_DIR="$BENCH_DIR/bookshelf"
    DP_OUT_DIR="$BENCH_DIR/dreamplace_out"
    mkdir -p "$BOOKSHELF_DIR" "$DP_OUT_DIR"
    python3 "$REPO_DIR/scripts/alphachip/pb_to_bookshelf.py" \
        --pb-file "$NETLIST" \
        --plc-file "$OPENROAD_PLC" \
        --out-dir "$BOOKSHELF_DIR" \
        --design e1_softmacro
    DP_PARAMS="$BENCH_DIR/dreamplace.params.json"
    python3 - "$BOOKSHELF_DIR" "$DP_OUT_DIR" "$DP_PARAMS" <<'PY'
import json
import sys

bookshelf_dir, out_dir, params_path = sys.argv[1:4]
params = {
    "aux_input": f"{bookshelf_dir}/e1_softmacro.aux",
    "gpu": 0,
    "num_bins_x": 64,
    "num_bins_y": 64,
    "global_place_stages": [{
        "num_bins_x": 64,
        "num_bins_y": 64,
        "iteration": 1000,
        "learning_rate": 0.01,
        "wirelength": "weighted_average",
        "optimizer": "nesterov",
        "Llambda_density_weight_iteration": 1,
        "Lsub_iteration": 1,
    }],
    "target_density": 0.8,
    "density_weight": 8e-05,
    "random_seed": 1337,
    "result_dir": out_dir,
    "global_place_flag": 1,
    "legalize_flag": 1,
    "detailed_place_flag": 1,
    "macro_place_flag": 0,
    "stop_overflow": 0.1,
    "deterministic_flag": 1,
    "num_threads": 8,
    "plot_flag": 0,
    "dtype": "float32",
    "scale_factor": 0.0,
    "shift_factor": [0.0, 0.0],
    "ignore_net_degree": 100,
    "gp_noise_ratio": 0.025,
    "enable_fillers": 1,
    "abacus_legalize_flag": 1,
}
with open(params_path, "w") as fh:
    json.dump(params, fh, indent=2, sort_keys=True)
PY

    if docker image inspect "$DREAMPLACE_IMAGE" >/dev/null 2>&1; then
        docker run --rm \
            -v "$DREAMPLACE_REPO:/DREAMPlace" \
            -v "$BENCH_DIR:$BENCH_DIR" \
            -w /DREAMPlace/install \
            "$DREAMPLACE_IMAGE" \
            bash -lc "pip install -q torch_optimizer==0.3.0 ncg_optimizer==0.2.2 pyunpack patool shapely 2>&1 | tail -1 && python3 dreamplace/Placer.py $DP_PARAMS"
        DP_PL="$DP_OUT_DIR/e1_softmacro/e1_softmacro.gp.pl"
        DP_PLC="$BENCH_DIR/e1_softmacro.dreamplace.plc"
        if [ -s "$DP_PL" ]; then
            python3 "$REPO_DIR/scripts/alphachip/gp_pl_to_ct_plc.py" \
                --pb-file "$NETLIST" \
                --src-plc "$OPENROAD_PLC" \
                --gp-pl "$DP_PL" \
                --out-plc "$DP_PLC"
            python3 "$REPO_DIR/scripts/alphachip/plc_hpwl.py" \
                --pb-file "$NETLIST" \
                --plc-file "$DP_PLC" \
                --out-json "$OUT_DIR/dreamplace_hpwl.json"
        fi
    else
        echo "DREAMPlace image $DREAMPLACE_IMAGE not present; skipping DREAMPlace step." >&2
    fi

    python3 "$REPO_DIR/scripts/alphachip/plc_hpwl.py" \
        --pb-file "$NETLIST" \
        --plc-file "$OPENROAD_PLC" \
        --out-json "$OUT_DIR/openroad_hpwl.json"
    if [ -f "$ALPHACHIP_PLC" ]; then
        python3 "$REPO_DIR/scripts/alphachip/plc_hpwl.py" \
            --pb-file "$NETLIST" \
            --plc-file "$ALPHACHIP_PLC" \
            --out-json "$OUT_DIR/alphachip_hpwl.json"
    fi
fi

# Post-route PPA truth (run_post_route_ppa.py). When OPENROAD_RUN_DIR is
# set, re-run OpenROAD detailed route on each .plc and capture routed
# wirelength, DRC, TNS, antenna, and power. The "False Dawn" critique
# (arXiv 2302.11014) makes this the only honest evaluation of AlphaChip
# vs OpenROAD vs DREAMPlace.
if [ "$SKIP_POST_ROUTE" = "1" ] || [ -z "$OPENROAD_RUN_DIR" ]; then
    cat <<EOF >&2

NOTE: post-route PPA truth NOT captured. proxy delta is informational only.
      To capture PPA truth: export OPENROAD_RUN_DIR=<openlane run dir> and re-run.
EOF
    exit 0
fi

PPA_OUT_DIR="$REPO_DIR/research/alpha_chip_macro_placement/07_post_route_ppa"
mkdir -p "$PPA_OUT_DIR"

echo "Capturing OpenROAD baseline post-route PPA..."
python3 "$REPO_DIR/scripts/run_post_route_ppa.py" \
    --plc "$OPENROAD_PLC" \
    --netlist "$NETLIST" \
    --openroad-run-dir "$OPENROAD_RUN_DIR" \
    --openlane-config "$OPENLANE_CONFIG" \
    --out-json "$PPA_OUT_DIR/openroad.json" \
    --skip-route

if [ -f "$ALPHACHIP_PLC" ]; then
    echo "Capturing AlphaChip candidate post-route PPA..."
    python3 "$REPO_DIR/scripts/run_post_route_ppa.py" \
        --plc "$ALPHACHIP_PLC" \
        --netlist "$NETLIST" \
        --openroad-run-dir "$OPENROAD_RUN_DIR" \
        --openlane-config "$OPENLANE_CONFIG" \
        --out-json "$PPA_OUT_DIR/alphachip.json"
fi

echo "Post-route PPA artifacts:"
find "$PPA_OUT_DIR" -maxdepth 1 -type f -name '*.json' -print | sort
