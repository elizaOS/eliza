#!/usr/bin/env bash
# W7 secure-boot negative-evidence: regenerate images, run all rejection cases
# + positive control, regenerate the W8 TeeEvidence fixture, then run both
# gates. Exits non-zero if any expected-reject case is accepted, the positive
# control is rejected, or either gate fails.
#
#   cd packages/chip && source tools/env.sh && tests/security/negative/run.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHIP_ROOT="$(cd "${HERE}/../../.." && pwd)"

# Pick an interpreter that has an Ed25519 backend (cryptography/nacl) or can
# fall back to the bundled pure-Python RFC 8032 reference. Prefer whatever
# `python3` resolves to (tools/env.sh sets the repo venv first).
PY="${PYTHON:-python3}"

echo "== W7: negative-boot rejection transcripts =="
"${PY}" "${HERE}/run.py"

echo
echo "== W8: regenerate RoT TeeEvidence fixture =="
"${PY}" "${HERE}/gen_evidence.py"

echo
echo "== gate: secure-boot negative evidence =="
"${PY}" "${CHIP_ROOT}/scripts/check_secure_boot_negative_evidence.py"

echo
echo "== gate: TEE attestation evidence (e1-rot fixture) =="
"${PY}" "${CHIP_ROOT}/scripts/check_tee_attestation_evidence.py" \
    "${CHIP_ROOT}/docs/spec-db/tee-attestation-evidence.e1-rot.json"

echo
echo "ALL PASS"
