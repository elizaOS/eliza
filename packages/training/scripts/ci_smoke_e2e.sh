#!/usr/bin/env bash
# End-to-end smoke for the corpus-quality chain.
#
# Exercises every link in the runtime-phase enforcement pipeline:
#   1. Audit  (--strict-phases against an OOB fixture)
#
# A failure of any step exits non-zero. The CI runs this; locally it can
# be run with `bash scripts/ci_smoke_e2e.sh` from the training package.
#
# Designed to need NO external network and NO GPU.

set -euo pipefail
cd "$(dirname "$0")/.."

PY=${PY:-python3}
WORK=$(mktemp -d -t milady-ci-XXXXXX)
trap 'rm -rf "$WORK"' EXIT

step() { echo; echo "[ci-smoke] $*"; }
fail() { echo "[ci-smoke] FAIL: $*" >&2; exit 1; }

# ─────────────────────────────────────────────────────────────────────
step "1. Audit --strict-phases against an OOB fixture"
mkdir -p "$WORK/strict/data/normalized"
# Synthetic conformant record (reply task_type)
"$PY" -c "
import json
rec = {
  'roomName': 'ok1', 'agentId': 'a',
  'memoryEntries': [],
  'currentMessage': {'role':'user','speaker':'u','content':'q','channel':'dm'},
  'expectedResponse': '{\"thought\":\"x\",\"actions\":[{\"name\":\"REPLY\",\"params\":{}}],\"providers\":[],\"text\":\"y\",\"simple\":true}',
  'availableActions': ['REPLY', 'IGNORE'],
  'metadata': {'task_type':'reply','source_dataset':'smoke'}
}
print(json.dumps(rec))" > "$WORK/strict/data/normalized/synth_reply.jsonl"
# OOB record (reasoning_cot)
"$PY" -c "
import json
rec = {
  'roomName': 'oob1', 'agentId': 'a',
  'memoryEntries': [],
  'currentMessage': {'role':'user','speaker':'u','content':'q','channel':'dm'},
  'expectedResponse': '{\"thought\":\"x\",\"text\":\"y\"}',
  'availableActions': ['REPLY'],
  'metadata': {'task_type':'reasoning_cot','source_dataset':'smoke'}
}
print(json.dumps(rec))" > "$WORK/strict/data/normalized/oob_smoke.jsonl"

set +e
"$PY" scripts/audit_pipeline_shapes.py --data-dir "$WORK/strict/data/normalized" \
  --out-md "$WORK/strict/AUDIT.md" --out-json "$WORK/strict/audit.json" \
  --strict-phases > "$WORK/strict/audit.log" 2>&1
rc=$?
set -e
[[ "$rc" == "2" ]] || fail "audit --strict-phases should exit 2 on OOB; got rc=$rc"

# Same dir without strict should exit 0
set +e
"$PY" scripts/audit_pipeline_shapes.py --data-dir "$WORK/strict/data/normalized" \
  --out-md "$WORK/strict/AUDIT2.md" --out-json "$WORK/strict/audit2.json" \
  > "$WORK/strict/audit2.log" 2>&1
rc=$?
set -e
[[ "$rc" == "0" ]] || fail "audit without --strict-phases should exit 0 even with OOB; got rc=$rc"

# ─────────────────────────────────────────────────────────────────────
echo
echo "[ci-smoke] OK — all smoke phases of the corpus-quality chain passed"
