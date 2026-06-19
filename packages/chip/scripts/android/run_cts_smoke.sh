#!/usr/bin/env bash
# Run the CTS smoke subset against a Cuttlefish riscv64 device.
# Fail closed if AOSP_TREE / cts-tradefed / adb device are missing.
# Modules + filters mirror docs/android/cts-vts-smoke-plan.md.

set -euo pipefail

die() { printf 'run_cts_smoke: %s\n' "$*" >&2; exit 2; }
require_cmd() { command -v "$1" >/dev/null 2>&1 || die "missing on PATH: $1"; }

AOSP_TREE="${AOSP_TREE:-}"
ARCHIVE_ROOT="${ARCHIVE_ROOT:-out/cf-riscv64/cts-vts}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE="${ARCHIVE_ROOT}/${TIMESTAMP}"
RESULT_JSON="${CTS_RESULT_JSON:-docs/evidence/android/e1-npu/cts-result.json}"
REFRESH_ANDROID_MANIFEST="${E1_NPU_REFRESH_ANDROID_MANIFEST:-1}"

[ -n "${AOSP_TREE}" ] || die "AOSP_TREE must point at a built AOSP riscv64 tree"
[ -d "${AOSP_TREE}" ] || die "AOSP_TREE does not exist: ${AOSP_TREE}"
TRADEFED="${AOSP_TREE}/out/host/linux-x86/cts/android-cts/tools/cts-tradefed"
[ -x "${TRADEFED}" ] || die "cts-tradefed not built: ${TRADEFED}"

require_cmd adb
DEVICES="$(adb devices | awk 'NR>1 && $2=="device" {print $1}')"
COUNT="$(printf '%s\n' "${DEVICES}" | grep -c . || true)"
[ "${COUNT}" = "1" ] || die "expected exactly 1 ready adb device, found ${COUNT}"

mkdir -p "${ARCHIVE}"
{
  echo "timestamp_utc=${TIMESTAMP}"
  echo "aosp_tree=${AOSP_TREE}"
  adb shell getprop ro.build.id
  adb shell getprop ro.product.cpu.abi
  adb shell getprop sys.boot_completed
} > "${ARCHIVE}/build-info.txt"
adb shell getprop > "${ARCHIVE}/device-info.txt" || true

set +e
set -x
"${TRADEFED}" run commandAndExit cts \
  --abi riscv64 \
  --module CtsNNAPITestCases \
  --module CtsLibcoreTestCases \
  --module CtsBionicTestCases \
  --module CtsJniTestCases \
  --module CtsUtilTestCases \
  --module CtsAppOpsTestCases \
  --module CtsPermissionTestCases \
  --module CtsSelinuxTargetSdkCurrentTestCases \
  --module CtsSecurityTestCases \
    --include-filter "CtsSecurityTestCases android.security.cts.SELinuxTest" \
    --include-filter "CtsSecurityTestCases android.security.cts.FileSystemPermissionTest" \
  --module CtsNetTestCases \
    --include-filter "CtsNetTestCases android.net.cts.SocketTest" \
    --include-filter "CtsNetTestCases android.net.cts.UriTest" \
  --log-level-display info \
  --skip-preconditions \
  2>&1 | tee "${ARCHIVE}/cts-stdout.log"
TRADEFED_RC=${PIPESTATUS[0]}
set +x
set -e

RESULTS_DIR=
for candidate in "${AOSP_TREE}"/out/host/linux-x86/cts/android-cts/results/*; do
  [ -d "${candidate}" ] || continue
  if [ -z "${RESULTS_DIR}" ] || [ "${candidate}" -nt "${RESULTS_DIR}" ]; then
    RESULTS_DIR="${candidate}"
  fi
done
if [ -n "${RESULTS_DIR}" ]; then
  cp -r "${RESULTS_DIR}" "${ARCHIVE}/cts-results/"
  echo "archived results: ${ARCHIVE}/cts-results/"
else
  echo "WARNING: no tradefed results directory found" >&2
fi
RESULT_JSON_PATH="${RESULT_JSON}"
case "${RESULT_JSON_PATH}" in
  /*) ;;
  *) RESULT_JSON_PATH="$(pwd)/${RESULT_JSON_PATH}" ;;
esac
mkdir -p "$(dirname "${RESULT_JSON_PATH}")"
RESULT_STATUS=FAIL
if [ "${TRADEFED_RC}" -eq 0 ]; then
  RESULT_STATUS=PASS
fi
python3 - "${RESULT_JSON_PATH}" "${RESULT_STATUS}" "${TRADEFED_RC}" "${ARCHIVE}" <<'PY'
import json
import sys
from datetime import UTC, datetime

out, status, rc, archive = sys.argv[1:5]
payload = {
    "schema": "eliza.e1_npu_android_cts_smoke_result.v1",
    "status": status,
    "CTS_SCOPE": "NNAPI smoke plus bounded riscv64 CTS smoke modules",
    "NNAPI": "CtsNNAPITestCases",
    "archive": archive,
    "RESULT": int(rc),
    "RESULT=0": int(rc) == 0,
    "date_utc": datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    "claim_boundary": "cts_smoke_only_not_full_android_compatibility_claim",
}
with open(out, "w", encoding="utf-8") as f:
    json.dump(payload, f, indent=2, sort_keys=True)
    f.write("\n")
PY
echo "CTS smoke archive: ${ARCHIVE}"
echo "CTS smoke result: ${RESULT_JSON_PATH}"
if [ "${REFRESH_ANDROID_MANIFEST}" = "1" ]; then
  set +e
  python3 "$(CDPATH=; cd -- "$(dirname -- "$0")/../.." && pwd)/scripts/assemble_e1_npu_android_proof_manifest.py"
  ASSEMBLE_RC=$?
  set -e
  if [ "${ASSEMBLE_RC}" -ne 0 ] && [ "${ASSEMBLE_RC}" -ne 2 ]; then
    exit "${ASSEMBLE_RC}"
  fi
fi
exit "${TRADEFED_RC}"
