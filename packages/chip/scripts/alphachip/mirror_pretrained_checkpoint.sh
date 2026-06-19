#!/usr/bin/env sh
# Fetch the AlphaChip pretrained TPU checkpoint from a private mirror.
#
# Background: as of 2026-05-20 the canonical upstream object at
#   https://storage.googleapis.com/rl-infra-public/circuit-training/tpu_checkpoint_20240815.tar.gz
# returns HTTP 403 (see docs/toolchain/alphachip-checkpoint-blocker.md and
# external/circuit_training/pin-manifest.json). No public mirror exists; the
# only recovery path is a private copy held by someone who downloaded it
# before Feb 2026.
#
# This script accepts that private URL via ALPHACHIP_MIRROR_URL (HTTP(S) URL or
# file:// path), downloads it to external/circuit_training/checkpoints/, and
# byte-verifies it against ALPHACHIP_MIRROR_SHA256 (required). It is the
# fallback path invoked by download_pretrained_checkpoint.sh when the canonical
# GCS URL fails.
#
# Usage:
#   ALPHACHIP_MIRROR_URL=https://internal/mirror/tpu_checkpoint_20240815.tar.gz \
#   ALPHACHIP_MIRROR_SHA256=<sha256> \
#     scripts/alphachip/mirror_pretrained_checkpoint.sh [OUT_DIR]
#
# Or with a local file:
#   ALPHACHIP_MIRROR_URL=file:///abs/path/to/tpu_checkpoint_20240815.tar.gz \
#   ALPHACHIP_MIRROR_SHA256=<sha256> \
#     scripts/alphachip/mirror_pretrained_checkpoint.sh
#
# On success the unpacked checkpoint sits at OUT_DIR (default
# external/circuit_training/checkpoints/tpu_checkpoint_20240815) and the script
# prints the absolute path to stdout. On any failure (URL unset, SHA mismatch,
# download error, extract error) the script exits non-zero and leaves no
# partial state in OUT_DIR.

set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH='' cd -- "${SCRIPT_DIR}/../.." && pwd)
DEFAULT_OUT_DIR="${REPO_ROOT}/external/circuit_training/checkpoints/tpu_checkpoint_20240815"

OUT_DIR="${1:-${ALPHACHIP_PRETRAINED_DIR:-${DEFAULT_OUT_DIR}}}"
MIRROR_URL="${ALPHACHIP_MIRROR_URL:-}"
MIRROR_SHA256="${ALPHACHIP_MIRROR_SHA256:-}"

if [ -z "${MIRROR_URL}" ]; then
    cat >&2 <<EOF
mirror_pretrained_checkpoint.sh: ALPHACHIP_MIRROR_URL is not set.

The upstream GCS object at
  https://storage.googleapis.com/rl-infra-public/circuit-training/tpu_checkpoint_20240815.tar.gz
has been returning HTTP 403 since Feb 2026 (see
docs/toolchain/alphachip-checkpoint-blocker.md). There is no public mirror.

To unblock locally:
  1. Obtain tpu_checkpoint_20240815.tar.gz from a colleague who pulled it
     before Feb 2026.
  2. Host it at a private URL (or place it on disk and use file://...).
  3. Compute its SHA256 and export both:
       export ALPHACHIP_MIRROR_URL=<url>
       export ALPHACHIP_MIRROR_SHA256=<sha256>
  4. Re-run this script (or download_pretrained_checkpoint.sh, which will
     fall back to it).
EOF
    exit 64
fi

if [ -z "${MIRROR_SHA256}" ]; then
    cat >&2 <<EOF
mirror_pretrained_checkpoint.sh: ALPHACHIP_MIRROR_SHA256 is not set.

A mirror without a pinned hash is not acceptable for this checkpoint. Upstream
never published a SHA256, so we pin against a known-good pre-Feb-2026 local
copy. Compute it once:
    sha256sum tpu_checkpoint_20240815.tar.gz
record it in external/circuit_training/pin-manifest.json under
artifacts[name=tpu_checkpoint_20240815].sha256, and export
ALPHACHIP_MIRROR_SHA256 before re-running.
EOF
    exit 64
fi

mkdir -p "$(dirname -- "${OUT_DIR}")"
ARCHIVE="${OUT_DIR}.tar.gz"
ARCHIVE_TMP="${ARCHIVE}.partial"
rm -f -- "${ARCHIVE}" "${ARCHIVE_TMP}"

case "${MIRROR_URL}" in
    file://*)
        SRC_PATH=${MIRROR_URL#file://}
        if [ ! -f "${SRC_PATH}" ]; then
            printf 'mirror_pretrained_checkpoint.sh: local mirror not found at %s\n' "${SRC_PATH}" >&2
            exit 66
        fi
        cp -- "${SRC_PATH}" "${ARCHIVE_TMP}"
        ;;
    http://*|https://*)
        if ! curl -L --fail --show-error -o "${ARCHIVE_TMP}" "${MIRROR_URL}"; then
            printf 'mirror_pretrained_checkpoint.sh: download failed from %s\n' "${MIRROR_URL}" >&2
            rm -f -- "${ARCHIVE_TMP}"
            exit 65
        fi
        ;;
    *)
        printf 'mirror_pretrained_checkpoint.sh: unsupported URL scheme: %s\n' "${MIRROR_URL}" >&2
        exit 64
        ;;
esac

ACTUAL_SHA256=$(sha256sum -- "${ARCHIVE_TMP}" | awk '{print $1}')
if [ "${ACTUAL_SHA256}" != "${MIRROR_SHA256}" ]; then
    printf 'mirror_pretrained_checkpoint.sh: SHA256 mismatch\n  expected: %s\n  actual:   %s\n' \
        "${MIRROR_SHA256}" "${ACTUAL_SHA256}" >&2
    rm -f -- "${ARCHIVE_TMP}"
    exit 67
fi

mv -- "${ARCHIVE_TMP}" "${ARCHIVE}"
rm -rf -- "${OUT_DIR}"
mkdir -p -- "${OUT_DIR}"
if ! tar -xzf "${ARCHIVE}" -C "${OUT_DIR}" --strip-components=1; then
    printf 'mirror_pretrained_checkpoint.sh: failed to extract %s\n' "${ARCHIVE}" >&2
    rm -rf -- "${OUT_DIR}"
    exit 68
fi

printf '%s\n' "${OUT_DIR}"
