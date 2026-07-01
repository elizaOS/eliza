#!/usr/bin/env sh
# Fetch the AlphaChip pretrained TPU checkpoint.
#
# Fallback chain:
#   1. Canonical GCS object documented by upstream (HTTP 403 since Feb 2026).
#   2. mirror_pretrained_checkpoint.sh — pulls from ALPHACHIP_MIRROR_URL with
#      required ALPHACHIP_MIRROR_SHA256 (a private pre-Feb-2026 copy).
#   3. bootstrap_pretrained_checkpoint.sh — materialises a fresh local
#      checkpoint by running run_pretraining.sh against the vendored Ariane
#      fixtures. Requires plc_wrapper_main to be on disk; otherwise the
#      bootstrap step itself fails closed with structured evidence in
#      build/reports/alphachip/pretraining-smoke.json.
#
# The script fails closed if all three paths fail.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)

OUT_DIR="${1:-${ALPHACHIP_PRETRAINED_DIR:-/tmp/e1-alphachip/tpu_checkpoint_20240815}}"
URL="${ALPHACHIP_PRETRAINED_URL:-https://storage.googleapis.com/rl-infra-public/circuit-training/tpu_checkpoint_20240815.tar.gz}"
ARCHIVE="${OUT_DIR}.tar.gz"

mkdir -p -- "$(dirname -- "${OUT_DIR}")"
rm -f -- "${ARCHIVE}"

if curl -L --fail --show-error "${URL}" -o "${ARCHIVE}"; then
    rm -rf -- "${OUT_DIR}"
    mkdir -p -- "${OUT_DIR}"
    tar -xzf "${ARCHIVE}" -C "${OUT_DIR}" --strip-components=1
    printf '%s\n' "${OUT_DIR}"
    exit 0
fi

cat >&2 <<EOF
download_pretrained_checkpoint.sh: canonical URL failed
  ${URL}
This is the documented upstream symptom since Feb 2026
(google-research/circuit_training#85/#86/#87, all 403). Trying
mirror_pretrained_checkpoint.sh next.
EOF

rm -f -- "${ARCHIVE}"

if [ -n "${ALPHACHIP_MIRROR_URL:-}" ]; then
    if ALPHACHIP_PRETRAINED_DIR="${OUT_DIR}" "${SCRIPT_DIR}/mirror_pretrained_checkpoint.sh" "${OUT_DIR}"; then
        exit 0
    fi
    printf 'download_pretrained_checkpoint.sh: mirror failed; falling through to local bootstrap.\n' >&2
else
    printf 'download_pretrained_checkpoint.sh: ALPHACHIP_MIRROR_URL unset; skipping mirror and falling through to local bootstrap.\n' >&2
fi

if ALPHACHIP_PRETRAINED_DIR="${OUT_DIR}" "${SCRIPT_DIR}/bootstrap_pretrained_checkpoint.sh" "${OUT_DIR}"; then
    exit 0
fi

cat >&2 <<EOF

All three checkpoint paths failed (canonical GCS, private mirror, local
bootstrap). See docs/toolchain/alphachip-checkpoint-blocker.md for the
unblock recipe. The most common reason for the bootstrap path to fail is a
missing plc_wrapper_main binary — see
build/reports/alphachip/pretraining-smoke.json for the structured cause.
EOF
exit 1
