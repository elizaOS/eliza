#!/usr/bin/env bash
# sign-firmware.sh — SOC2 CC6.1, CC6.8, CC8.1 — Eliza chip firmware signing.
#
# Sign a firmware blob with an Ed25519 key handle resolved via the Eliza
# @elizaos/security KMS. RSA-4096 PSS is also acceptable when the silicon
# secure-boot ROM expects RSA (the boot ROM verifies in hardware, so the
# algorithm choice is dictated by the chip; we accept both).
#
# Usage:
#   sign-firmware.sh --in firmware.bin --out firmware.bin.sig \
#       [--algo ed25519|rsa-pss-sha256] [--purpose chip-firmware]
#
# Environment:
#   ELIZA_KMS_PASSPHRASE        Required for the local KMS adapter.
#   ELIZA_KMS_SALT              Optional; defaults to elizaos.kms.local.v1.
#
# Output:
#   <out>          raw signature bytes (size depends on --algo)
#   <out>.json     JSON record { sig, key_id, key_version, algorithm, public_key }
#
# This script DOES NOT sign a production firmware blob automatically. It is
# the tooling component of the human-in-loop signing flow documented in
# README.md. The human operator must explicitly invoke it against a vetted
# blob; CI must NOT auto-sign.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
KMS_SIGN_SHIM="${REPO_ROOT}/packages/security/scripts/kms-sign.ts"

ALGO="ed25519"
PURPOSE="chip-firmware"
IN_FILE=""
OUT_FILE=""

usage() {
  cat <<USAGE
Usage: $0 --in firmware.bin --out firmware.bin.sig [--algo ed25519|rsa-pss-sha256] [--purpose chip-firmware]

Signs a firmware blob via the @elizaos/security KMS. SOC2 CC6.1/CC6.8/CC8.1.

USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --in) IN_FILE="$2"; shift 2 ;;
    --out) OUT_FILE="$2"; shift 2 ;;
    --algo) ALGO="$2"; shift 2 ;;
    --purpose) PURPOSE="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ -z "${IN_FILE}" || -z "${OUT_FILE}" ]]; then
  usage
  exit 2
fi
if [[ ! -f "${IN_FILE}" ]]; then
  echo "input firmware blob not found: ${IN_FILE}" >&2
  exit 2
fi
if [[ ! -f "${KMS_SIGN_SHIM}" ]]; then
  echo "kms-sign shim missing: ${KMS_SIGN_SHIM}" >&2
  exit 2
fi

if [[ "${ALGO}" != "ed25519" && "${ALGO}" != "rsa-pss-sha256" ]]; then
  echo "unsupported --algo ${ALGO} (expected ed25519 or rsa-pss-sha256)" >&2
  exit 2
fi

if [[ -z "${ELIZA_KMS_PASSPHRASE:-}" ]]; then
  echo "ELIZA_KMS_PASSPHRASE must be set" >&2
  exit 2
fi

RUNNER=""
if command -v bun >/dev/null 2>&1; then
  RUNNER="bun run"
elif command -v tsx >/dev/null 2>&1; then
  RUNNER="tsx"
else
  echo "need 'bun' or 'tsx' on PATH to invoke kms-sign" >&2
  exit 2
fi

OUT_JSON="${OUT_FILE}.json"

echo "[sign-firmware] in=${IN_FILE} out=${OUT_FILE} algo=${ALGO} purpose=${PURPOSE}" >&2

# kms-sign emits the JSON record AND writes a raw .sig file next to the input.
# We move/copy to the operator-specified output paths.
${RUNNER} "${KMS_SIGN_SHIM}" \
  --purpose "${PURPOSE}" \
  --in "${IN_FILE}" \
  --out "${OUT_JSON}"

# kms-sign drops <input>.sig as raw bytes; move it to the requested out path.
RAW_FROM_SHIM="${IN_FILE}.sig"
if [[ "${RAW_FROM_SHIM}" != "${OUT_FILE}" ]]; then
  mv "${RAW_FROM_SHIM}" "${OUT_FILE}"
fi

echo "[sign-firmware] wrote ${OUT_FILE} + ${OUT_JSON}" >&2
echo "[sign-firmware] DO NOT commit the .sig — store next to firmware in the release artifact bundle." >&2
