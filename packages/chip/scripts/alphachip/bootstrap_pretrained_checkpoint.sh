#!/usr/bin/env sh
# Bootstrap an AlphaChip pretrained checkpoint locally by running the
# pretraining smoke harness and laying the resulting policy directory out under
# the same name as the upstream tarball (tpu_checkpoint_20240815).
#
# This is the third-tier fallback in the download chain:
#   1. download_pretrained_checkpoint.sh tries the canonical GCS URL (currently
#      403; see docs/toolchain/alphachip-checkpoint-blocker.md).
#   2. If that fails, it tries mirror_pretrained_checkpoint.sh (requires
#      ALPHACHIP_MIRROR_URL + ALPHACHIP_MIRROR_SHA256).
#   3. If the mirror is unset, it falls through to this script, which produces
#      a fresh local policy by running scripts/alphachip/run_pretraining.sh.
#
# This script only succeeds when the closed-source plc_wrapper_main binary is
# already on disk (run_pretraining.sh fails closed otherwise). It is therefore
# a true fallback rather than a guarantee — but it is the only path that
# does not depend on a pre-Feb-2026 colleague-held tarball, because the
# checkpoint it produces is materialised from a *training run* rather than
# downloaded.
#
# A bootstrapped checkpoint is functionally distinct from the released
# 20-block TPU checkpoint: it is a single-iteration smoke checkpoint, not a
# 20-block pre-trained policy. Treat it as the minimum-viable starting point
# for further training, not as the upstream pretrained policy.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH='' cd -- "${SCRIPT_DIR}/../.." && pwd)
DEFAULT_OUT_DIR="${REPO_ROOT}/external/circuit_training/checkpoints/tpu_checkpoint_20240815"
OUT_DIR="${1:-${ALPHACHIP_PRETRAINED_DIR:-${DEFAULT_OUT_DIR}}}"

PRETRAIN_ROOT="${ALPHACHIP_PRETRAIN_ROOT:-${REPO_ROOT}/build/alphachip/pretraining-smoke/run_00}"
EVIDENCE_FILE="${REPO_ROOT}/build/reports/alphachip/pretraining-smoke.json"

printf 'bootstrap_pretrained_checkpoint.sh: invoking run_pretraining.sh to materialise a local checkpoint\n' >&2

ROOT_DIR="${PRETRAIN_ROOT}" \
    "${SCRIPT_DIR}/run_pretraining.sh" || {
    rc=$?
    printf 'bootstrap_pretrained_checkpoint.sh: run_pretraining.sh exited %s; see %s\n' "${rc}" "${EVIDENCE_FILE}" >&2
    exit "${rc}"
}

# run_pretraining.sh writes the policy under $ROOT_DIR/policy and
# $ROOT_DIR/saved_model in tf-agents' standard layout. Mirror that into the
# expected upstream tarball layout.
POLICY_SRC="${PRETRAIN_ROOT}/policy"
SAVED_MODEL_SRC="${PRETRAIN_ROOT}/saved_model"

if [ ! -d "${POLICY_SRC}" ] && [ ! -d "${SAVED_MODEL_SRC}" ]; then
    cat >&2 <<EOF
bootstrap_pretrained_checkpoint.sh: training did not write a policy directory
under ${PRETRAIN_ROOT}. tf-agents normally writes ./policy and ./saved_model
after the first iteration. See ${EVIDENCE_FILE} for the smoke result.
EOF
    exit 7
fi

rm -rf -- "${OUT_DIR}"
mkdir -p -- "${OUT_DIR}"
[ -d "${POLICY_SRC}" ]      && cp -a "${POLICY_SRC}"      "${OUT_DIR}/policy"
[ -d "${SAVED_MODEL_SRC}" ] && cp -a "${SAVED_MODEL_SRC}" "${OUT_DIR}/saved_model"

printf '%s\n' "${OUT_DIR}"
