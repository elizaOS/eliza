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
#       --release-dir ~/eliza-training/samantha-lora-baseline/out \
#       --hf-repo elizalabs/eliza-1-voice-kokoro-samantha \
#       --dry-run
#
#   HF_TOKEN=hf_xxx ./publish_samantha.sh \
#       --release-dir ~/eliza-training/samantha-lora-baseline/out \
#       --hf-repo elizalabs/eliza-1-voice-kokoro-samantha \
#       --push --private
#
# Flags:
#
#   --release-dir PATH    Directory produced by export_adapter.py +
#                         eval_voice.py. Must contain manifest.json,
#                         eval.json, gate_report.json, and the
#                         af_same.bin artifact.
#
#   --hf-repo REPO        Target HF repo. Defaults to
#                         elizalabs/eliza-1-voice-kokoro-samantha. The
#                         catalog (voice-models.ts) points here.
#
#   --dry-run             Validate everything; print what would be
#                         uploaded; do not push. Default behaviour when
#                         neither --dry-run nor --push is passed.
#
#   --push                Actually push. Requires HF_TOKEN.
#
#   --private             Push as a private HF repo.
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
HF_REPO="elizalabs/eliza-1-voice-kokoro-samantha"
DRY_RUN=1
PUSH=0
PRIVATE=0
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
EXPORT_MANIFEST="${RELEASE_DIR}/manifest.json"
EVAL_JSON="${RELEASE_DIR}/eval.json"

for required in "${GATE_REPORT}" "${EXPORT_MANIFEST}" "${EVAL_JSON}"; do
    if [[ ! -f "${required}" ]]; then
        echo "[publish_samantha] required file missing: ${required}" >&2
        echo "  Run export_adapter.py + eval_voice.py first." >&2
        exit 1
    fi
done

GATE_PASSED="$(python3 -c "import json,sys; print(json.load(open('${GATE_REPORT}'))['passed'])")"
if [[ "${GATE_PASSED}" != "True" ]]; then
    echo "[publish_samantha] gate_report.passed=${GATE_PASSED}; refusing to publish." >&2
    echo "  See ${GATE_REPORT} and packages/training/benchmarks/voice_gates.md." >&2
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
if [[ "${PRIVATE}" -eq 1 ]]; then
    PUSH_ARGS+=(--private)
fi
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
