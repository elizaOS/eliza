#!/usr/bin/env bash
# scripts/run_asap7_block.sh — invoke the OpenROAD ORFS asap7 platform on one
# block from pd/asap7/config.asap7.yaml.
#
# Fail-closed contract:
#   - Returns 0 only when the ORFS flow has produced a shape JSON tagged
#     evidence_class=predictive_finfet_shape_only_not_signoff.
#   - Returns 1 with a BLOCKED message otherwise. Never produces silent or
#     partial evidence.
#
# Inputs:
#   $1 — block id (e.g., big_core_shell)
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

# Preflight: ORFS reachable (local checkout or docker image).
ORFS_MODE=""
if [[ -d "$ORFS_FLOW_HOME" ]]; then
    ORFS_MODE="local"
elif command -v docker >/dev/null 2>&1; then
    ORFS_MODE="docker"
else
    echo "BLOCKED: neither ORFS_FLOW_HOME=$ORFS_FLOW_HOME nor docker is available" >&2
    exit 1
fi

# Preflight: block id is declared in the config.
if ! grep -E "^[[:space:]]*-[[:space:]]*id:[[:space:]]*${BLOCK_ID}\b" "$CONFIG_PATH" >/dev/null; then
    echo "BLOCKED: block id ${BLOCK_ID} not declared in $CONFIG_PATH" >&2
    exit 1
fi

mkdir -p "$EVIDENCE_DIR"
OUTPUT_JSON="${EVIDENCE_DIR}/${BLOCK_ID}_shape.json"

# At this point the lane is ready in principle. We do not, however, run ORFS
# automatically here. ORFS is multi-stage, requires several gigabytes of
# container layers + ASAP7 install, and an interactive operator decision on
# clock/utilization for each block. The contract is:
#   1. Preflight passes (PDK + ORFS reachable).
#   2. Operator runs ORFS for the block (see README) and copies the post-route
#      shape JSON into $OUTPUT_JSON with evidence_class set correctly.
#   3. This script verifies the operator-produced shape JSON has the correct
#      evidence_class tag before exiting 0.
#
# Fail-closed: if the post-route JSON does not exist, we exit 1 with the
# next-step command.

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
