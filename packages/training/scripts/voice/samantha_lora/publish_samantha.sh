#!/usr/bin/env bash
# Push a trained + gated Samantha adapter to HuggingFace.
#
# Wraps the existing `push_voice_to_hf.py` (kokoro flow) with the
# samantha-lora-specific safety checks:
#
#   - Refuses to run without HF_TOKEN exported (no pre-flight prompts —
#     this script is meant to run unattended after the operator has
#     reviewed the gate_report.json).
#   - Refuses to run when gate_report.json says any gate failed.
#   - Updates `packages/shared/src/local-inference/voice-models.ts`
#     metadata pointer (sha256 + sizeBytes) only when --update-catalog
#     is passed AND the push succeeds.
#
# Usage:
#
#   HF_TOKEN=hf_xxx ./publish_samantha.sh \
#       --release-dir ~/eliza-training/samantha-lora-baseline/release/af_same \
#       --hf-repo elizaos/eliza-1 \
#       --dry-run
#
#   HF_TOKEN=hf_xxx ./publish_samantha.sh \
#       --release-dir ~/eliza-training/samantha-lora-baseline/release/af_same \
#       --hf-repo elizaos/eliza-1 \
#       --push --private
#
# Flags:
#
#   --release-dir PATH    Packaged Kokoro voice release directory, usually
#                         <run>/release/af_same. Must contain voice.bin,
#                         voice-preset.json, manifest-fragment.json,
#                         eval.json, and optional kokoro.onnx / gate_report.json.
#                         If gate_report.json is absent, eval.json.gateResult
#                         is used.
#
#   --hf-repo REPO        Target HF repo. Defaults to elizaos/eliza-1.
#                         push_voice_to_hf.py uploads under
#                         voice/kokoro/voices/<release-dir-name>.bin, with
#                         metadata under voice/kokoro/voices/<release-dir-name>/.
#
#   --dry-run             Validate everything; print what would be
#                         uploaded; do not push. Default behaviour when
#                         neither --dry-run nor --push is passed.
#
#   --push                Actually push. Requires HF_TOKEN.
#
#   --private             Push as a private HF repo. This is also the default
#                         for Samantha because the source corpus is research-only.
#
#   --update-catalog      After a successful push, run
#                         scripts/voice/update_kokoro_voice_catalog.py to
#                         refresh sha256 + sizeBytes in the runtime
#                         catalog. Only meaningful with --push.
#
# Exit codes:
#   0  push (or dry-run plan) succeeded.
#   1  preconditions failed (gate, missing files, missing HF_TOKEN).
#   2  underlying push_voice_to_hf.py exited non-zero.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRAINING_ROOT="$(cd "${HERE}/../../.." && pwd)"
PUSH_SCRIPT="${TRAINING_ROOT}/scripts/kokoro/push_voice_to_hf.py"

RELEASE_DIR=""
HF_REPO="elizaos/eliza-1"
DRY_RUN=1
PUSH=0
PRIVATE=1
UPDATE_CATALOG=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --release-dir) RELEASE_DIR="$2"; shift 2;;
        --hf-repo)     HF_REPO="$2";     shift 2;;
        --dry-run)     DRY_RUN=1; PUSH=0; shift;;
        --push)        PUSH=1; DRY_RUN=0; shift;;
        --private)     PRIVATE=1; shift;;
        --update-catalog) UPDATE_CATALOG=1; shift;;
        -h|--help)
            sed -n '2,38p' "${BASH_SOURCE[0]}"
            exit 0
            ;;
        *)
            echo "unknown flag: $1" >&2
            exit 2
            ;;
    esac
done

if [[ -z "${RELEASE_DIR}" ]]; then
    echo "[publish_samantha] --release-dir is required" >&2
    exit 1
fi

if [[ ! -d "${RELEASE_DIR}" ]]; then
    echo "[publish_samantha] release dir does not exist: ${RELEASE_DIR}" >&2
    exit 1
fi

GATE_REPORT="${RELEASE_DIR}/gate_report.json"
EVAL_JSON="${RELEASE_DIR}/eval.json"

for required in \
    "${EVAL_JSON}" \
    "${RELEASE_DIR}/voice.bin" \
    "${RELEASE_DIR}/voice-preset.json" \
    "${RELEASE_DIR}/manifest-fragment.json"; do
    if [[ ! -f "${required}" ]]; then
        echo "[publish_samantha] required file missing: ${required}" >&2
        echo "  Run export_adapter.py, eval_voice.py, then package_voice_for_release.py." >&2
        exit 1
    fi
done

GATE_PASSED="$(python3 - "${GATE_REPORT}" "${EVAL_JSON}" <<'PY'
import json
import sys
from pathlib import Path

gate_path = Path(sys.argv[1])
eval_path = Path(sys.argv[2])
if gate_path.is_file():
    data = json.loads(gate_path.read_text())
    print(data.get("passed"))
else:
    data = json.loads(eval_path.read_text())
    print((data.get("gateResult") or {}).get("passed"))
PY
)"
if [[ "${GATE_PASSED}" != "True" ]]; then
    echo "[publish_samantha] publish gate passed=${GATE_PASSED}; refusing to publish." >&2
    echo "  See ${GATE_REPORT} or ${EVAL_JSON} plus packages/training/benchmarks/voice_gates.md." >&2
    exit 1
fi

if [[ "${PUSH}" -eq 1 ]]; then
    if [[ -z "${HF_TOKEN:-}" ]]; then
        echo "[publish_samantha] HF_TOKEN is not set; refusing to push." >&2
        exit 1
    fi
fi

if [[ ! -f "${PUSH_SCRIPT}" ]]; then
    echo "[publish_samantha] push_voice_to_hf.py missing at ${PUSH_SCRIPT}" >&2
    exit 1
fi

PUSH_ARGS=(
    --release-dir "${RELEASE_DIR}"
    --hf-repo "${HF_REPO}"
)
if [[ "${DRY_RUN}" -eq 1 ]]; then
    PUSH_ARGS+=(--dry-run)
fi

echo "[publish_samantha] invoking: python3 ${PUSH_SCRIPT} ${PUSH_ARGS[*]}"
python3 "${PUSH_SCRIPT}" "${PUSH_ARGS[@]}"
PUSH_RC=$?

if [[ "${PUSH_RC}" -ne 0 ]]; then
    echo "[publish_samantha] push_voice_to_hf.py exited ${PUSH_RC}" >&2
    exit 2
fi

if [[ "${PUSH}" -eq 1 ]] && [[ "${UPDATE_CATALOG}" -eq 1 ]]; then
    UPDATE_SCRIPT="${TRAINING_ROOT}/scripts/voice/update_kokoro_voice_catalog.py"
    if [[ -f "${UPDATE_SCRIPT}" ]]; then
        echo "[publish_samantha] refreshing voice-models.ts catalog…"
        python3 "${UPDATE_SCRIPT}" --release-dir "${RELEASE_DIR}" --hf-repo "${HF_REPO}"
    else
        echo "[publish_samantha] update_kokoro_voice_catalog.py not yet shipped — skipping catalog refresh." >&2
    fi
fi

echo "[publish_samantha] done."
