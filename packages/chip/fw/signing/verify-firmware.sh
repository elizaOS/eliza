#!/usr/bin/env bash
# verify-firmware.sh — companion to sign-firmware.sh.
#
# Verifies the Ed25519 / RSA-PSS-SHA256 signature on a firmware blob. The
# intended call sites are:
#
#   - the host-side flashing tool BEFORE writing to the device,
#   - the device-side secure-boot ROM (which must perform the same check
#     in hardware; this script is the off-device check-of-record),
#   - CI release-gate jobs that verify a published bundle before it ships.
#
# Usage:
#   verify-firmware.sh --in firmware.bin --sig firmware.bin.sig.json
#
# Exit code 0 on valid, 1 on invalid, 2 on argument errors.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
KMS_VERIFY_SHIM="${REPO_ROOT}/packages/security/scripts/kms-verify.ts"

IN_FILE=""
SIG_FILE=""

usage() {
  cat <<USAGE
Usage: $0 --in firmware.bin --sig firmware.bin.sig.json

Verifies a firmware signature produced by sign-firmware.sh.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --in) IN_FILE="$2"; shift 2 ;;
    --sig) SIG_FILE="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ -z "${IN_FILE}" || -z "${SIG_FILE}" ]]; then
  usage
  exit 2
fi
if [[ ! -f "${IN_FILE}" || ! -f "${SIG_FILE}" ]]; then
  echo "missing input(s): in=${IN_FILE} sig=${SIG_FILE}" >&2
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
  echo "need 'bun' or 'tsx' on PATH" >&2
  exit 2
fi

${RUNNER} "${KMS_VERIFY_SHIM}" --sig "${SIG_FILE}" --in "${IN_FILE}"
