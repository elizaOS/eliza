#!/usr/bin/env bash
# scripts/run_asap7_block.sh — run one block from pd/asap7/config.asap7.yaml
# against the ASAP7 7p5t 27 nm RVT TT corner.
#
# Two flow modes are supported per block:
#   1. ORFS post-route shape (default): the operator runs ORFS for the block
#      and copies the post-route shape JSON in. This script verifies the tag.
#   2. Yosys + ABC synth-only shape: when the block declares
#      flow_mode=yosys_abc_synth_only in pd/asap7/config.asap7.yaml, the
#      script invokes scripts/run_asap7_leaf_synth.py directly and writes the
#      synth-only shape JSON itself.
#
# Fail-closed contract:
#   - Returns 0 only when a shape JSON exists at the documented path AND is
#     tagged evidence_class=predictive_finfet_shape_only_not_signoff with the
#     correct pdk + block_id fields.
#   - Returns 1 with a BLOCKED message otherwise. Never produces silent or
#     partial evidence.
#
# Inputs:
#   $1 — block id (e.g., big_core_shell, tage_table)
#   $2 — config path (e.g., pd/asap7/config.asap7.yaml)
#   $3 — evidence directory (docs/evidence/process/asap7)
#
# Environment:
#   ORFS_FLOW_HOME — OpenROAD-flow-scripts checkout
#   ASAP7_ROOT     — ASAP7 PDK checkout
#   ORFS_IMAGE     — optional container image when ORFS_FLOW_HOME is unset

set -euo pipefail

if [[ $# -ne 3 ]]; then
    echo "usage: $0 <block_id> <config> <evidence_dir>" >&2
    exit 2
fi

BLOCK_ID="$1"
CONFIG_PATH="$2"
EVIDENCE_DIR="$3"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ASAP7_ROOT="${ASAP7_ROOT:-$REPO_ROOT/external/pdks/asap7}"
ORFS_FLOW_HOME="${ORFS_FLOW_HOME:-$REPO_ROOT/external/OpenROAD-flow-scripts}"
ORFS_IMAGE="${ORFS_IMAGE:-openroad/orfs:latest}"

# Preflight: ASAP7 PDK present.
if [[ ! -d "$ASAP7_ROOT" ]]; then
    echo "BLOCKED: ASAP7 PDK missing at $ASAP7_ROOT" >&2
    echo "         clone with: make -C pd/asap7 clone-asap7" >&2
    exit 1
fi

# Preflight: block id is declared in the config.
if ! grep -E "^[[:space:]]*-[[:space:]]*id:[[:space:]]*${BLOCK_ID}\b" "$CONFIG_PATH" >/dev/null; then
    echo "BLOCKED: block id ${BLOCK_ID} not declared in $CONFIG_PATH" >&2
    exit 1
fi

# Resolve the per-block flow_mode (yosys_abc_synth_only | <default ORFS>) and
# the declared RTL file list directly from the config so we can dispatch to
# the right runner without hand-coding per-block paths.
PY=$(command -v python3 || command -v python)
if [[ -z "$PY" ]]; then
    echo "BLOCKED: python not found; cannot read config" >&2
    exit 1
fi
read -r FLOW_MODE CLOCK_MHZ MEMORY_INFER PARAMS_RAW RTL_FILES_RAW < <("$PY" - "$CONFIG_PATH" "$BLOCK_ID" <<'PYEOF'
import sys
import yaml
cfg_path, block_id = sys.argv[1], sys.argv[2]
data = yaml.safe_load(open(cfg_path, encoding="utf-8"))
for block in data.get("blocks", []):
    if block.get("id") == block_id:
        mode = block.get("flow_mode") or "orfs_post_route"
        clock = block.get("clock_target_mhz") or 1000
        mem_infer = "1" if block.get("memory_inference") else "0"
        params = block.get("synth_params") or {}
        param_str = ",".join(f"{k}={v}" for k, v in sorted(params.items())) or "-"
        rtl = ",".join(block.get("rtl_files") or [])
        print(f"{mode} {clock} {mem_infer} {param_str} {rtl}")
        break
else:
    sys.exit(2)
PYEOF
)
if [[ -z "$FLOW_MODE" ]]; then
    echo "BLOCKED: could not resolve flow_mode for block ${BLOCK_ID}" >&2
    exit 1
fi

mkdir -p "$EVIDENCE_DIR"
OUTPUT_JSON="${EVIDENCE_DIR}/${BLOCK_ID}_shape.json"

if [[ "$FLOW_MODE" == "yosys_abc_synth_only" ]]; then
    # Synth-only mode (no ORFS dependency). Drive yosys+ABC with the per-block
    # RTL list and the ASAP7 7p5t 27 RVT TT corner liberty files.
    LIB_DIR="${REPO_ROOT}/build/asap7/lib"
    mkdir -p "$LIB_DIR"

    EXTRACTOR="${REPO_ROOT}/scripts/extract_asap7_libs.py"
    if [[ ! -x "$EXTRACTOR" && ! -f "$EXTRACTOR" ]]; then
        echo "BLOCKED: missing $EXTRACTOR" >&2
        exit 1
    fi
    "$PY" "$EXTRACTOR" \
        --asap7-root "$ASAP7_ROOT" \
        --out-dir "$LIB_DIR" \
        --library asap7sc7p5t_27 \
        --vt RVT \
        --corner TT \
        || { echo "BLOCKED: ASAP7 liberty extraction failed" >&2; exit 1; }

    RTL_ARGS=()
    IFS=',' read -ra RTL_LIST <<<"$RTL_FILES_RAW"
    for rtl in "${RTL_LIST[@]}"; do
        if [[ -z "$rtl" ]]; then continue; fi
        if [[ ! -f "${REPO_ROOT}/${rtl}" ]]; then
            echo "BLOCKED: configured rtl file missing: ${rtl}" >&2
            exit 1
        fi
        RTL_ARGS+=("--rtl" "${REPO_ROOT}/${rtl}")
    done
    if [[ ${#RTL_ARGS[@]} -eq 0 ]]; then
        echo "BLOCKED: no rtl_files declared for ${BLOCK_ID}" >&2
        exit 1
    fi

    LIB_ARGS=()
    for lib in "$LIB_DIR"/asap7sc7p5t_*_RVT_TT_*.lib; do
        [[ -f "$lib" ]] && LIB_ARGS+=("--lib" "$lib")
    done
    if [[ ${#LIB_ARGS[@]} -eq 0 ]]; then
        echo "BLOCKED: no liberty files in $LIB_DIR" >&2
        exit 1
    fi

    CLOCK_PS=$(awk -v mhz="$CLOCK_MHZ" 'BEGIN{ if (mhz>0) print int(1.0e6 / mhz); }')

    PARAM_ARGS=()
    if [[ -n "$PARAMS_RAW" && "$PARAMS_RAW" != "-" ]]; then
        IFS=',' read -ra PARAM_LIST <<<"$PARAMS_RAW"
        for kv in "${PARAM_LIST[@]}"; do
            [[ -n "$kv" ]] && PARAM_ARGS+=("--param" "$kv")
        done
    fi
    MEMORY_ARGS=()
    if [[ "$MEMORY_INFER" == "1" ]]; then
        MEMORY_ARGS+=("--memory-inference")
    fi

    "$PY" "${REPO_ROOT}/scripts/run_asap7_leaf_synth.py" \
        --module "$BLOCK_ID" \
        "${RTL_ARGS[@]}" \
        "${LIB_ARGS[@]}" \
        --build-dir "${REPO_ROOT}/build/asap7/${BLOCK_ID}" \
        --output "$OUTPUT_JSON" \
        --clock-ps "${CLOCK_PS:-0}" \
        "${PARAM_ARGS[@]}" \
        "${MEMORY_ARGS[@]}" \
        || { echo "BLOCKED: scripts/run_asap7_leaf_synth.py failed for ${BLOCK_ID}" >&2; exit 1; }
else
    # Default ORFS post-route mode: preflight ORFS reachable and verify that
    # the operator-produced shape JSON exists and is tagged correctly.
    ORFS_MODE=""
    if [[ -d "$ORFS_FLOW_HOME" ]]; then
        ORFS_MODE="local"
    elif command -v docker >/dev/null 2>&1; then
        ORFS_MODE="docker"
    else
        echo "BLOCKED: neither ORFS_FLOW_HOME=$ORFS_FLOW_HOME nor docker is available" >&2
        exit 1
    fi

    if [[ ! -f "$OUTPUT_JSON" ]]; then
        cat >&2 <<EOF
BLOCKED: no shape JSON at $OUTPUT_JSON
         Preflight passed (ASAP7 PDK at $ASAP7_ROOT, ORFS mode=$ORFS_MODE).
         Next step:
           1. cd \$ORFS_FLOW_HOME/flow
           2. Configure platform=asap7 and design=$BLOCK_ID per pd/asap7/config.asap7.yaml
           3. After ORFS post-route, write shape JSON to:
                $OUTPUT_JSON
              with:
                {
                  "block_id": "$BLOCK_ID",
                  "evidence_class": "predictive_finfet_shape_only_not_signoff",
                  "pdk": "ASAP7",
                  ...
                }
           4. Re-run this script.
EOF
        exit 1
    fi
fi

# Verify the shape JSON has the expected evidence_class.
PY=$(command -v python3 || command -v python)
if [[ -z "$PY" ]]; then
    echo "BLOCKED: python not found; cannot verify shape JSON" >&2
    exit 1
fi
"$PY" - "$OUTPUT_JSON" "$BLOCK_ID" <<'PYEOF'
import json
import sys

path, expected_block = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as fh:
    data = json.load(fh)
ec = data.get("evidence_class")
if ec != "predictive_finfet_shape_only_not_signoff":
    print(
        f"BLOCKED: {path} evidence_class={ec!r}; "
        "expected predictive_finfet_shape_only_not_signoff",
        file=sys.stderr,
    )
    raise SystemExit(1)
if data.get("pdk") != "ASAP7":
    print(f"BLOCKED: {path} pdk={data.get('pdk')!r}; expected 'ASAP7'", file=sys.stderr)
    raise SystemExit(1)
if data.get("block_id") != expected_block:
    print(
        f"BLOCKED: {path} block_id={data.get('block_id')!r}; expected {expected_block!r}",
        file=sys.stderr,
    )
    raise SystemExit(1)
print(f"OK {path} evidence_class={ec} block_id={expected_block}")
PYEOF
exit $?
