#!/usr/bin/env bash
# Run the VTS smoke subset against a Cuttlefish riscv64 device.
# Fail closed if AOSP_TREE / vts-tradefed / adb device are missing.

set -euo pipefail

die() { printf 'run_vts_smoke: %s\n' "$*" >&2; exit 2; }
require_cmd() { command -v "$1" >/dev/null 2>&1 || die "missing on PATH: $1"; }

AOSP_TREE="${AOSP_TREE:-}"
ARCHIVE_ROOT="${ARCHIVE_ROOT:-out/cf-riscv64/cts-vts}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE="${ARCHIVE_ROOT}/${TIMESTAMP}"
RESULT_JSON="${VTS_RESULT_JSON:-docs/evidence/android/e1-npu/vts-result.json}"
REFRESH_ANDROID_MANIFEST="${E1_NPU_REFRESH_ANDROID_MANIFEST:-1}"

[ -n "${AOSP_TREE}" ] || die "AOSP_TREE must point at a built AOSP riscv64 tree"
[ -d "${AOSP_TREE}" ] || die "AOSP_TREE does not exist: ${AOSP_TREE}"
TRADEFED="${AOSP_TREE}/out/host/linux-x86/vts/android-vts/tools/vts-tradefed"
[ -x "${TRADEFED}" ] || die "vts-tradefed not built: ${TRADEFED}"

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
  adb shell cat /vendor/etc/vintf/manifest.xml 2>/dev/null | head -200 || true
} > "${ARCHIVE}/build-info.txt"
adb shell getprop > "${ARCHIVE}/device-info.txt" || true

set +e
set -x
"${TRADEFED}" run commandAndExit vts \
  --module VtsKernelConfigTest \
  --module VtsKernelProcFileApiTest \
  --module VtsTrebleVintfTest \
  --module VtsBinderTest \
  --module VtsHalManagerTest \
  --module VtsSecuritySELinuxPolicyHostTest \
  --log-level-display info \
  --skip-preconditions \
  2>&1 | tee "${ARCHIVE}/vts-stdout.log"
TRADEFED_RC=${PIPESTATUS[0]}
set +x
set -e

RESULTS_DIR=
for candidate in "${AOSP_TREE}"/out/host/linux-x86/vts/android-vts/results/*; do
  [ -d "${candidate}" ] || continue
  if [ -z "${RESULTS_DIR}" ] || [ "${candidate}" -nt "${RESULTS_DIR}" ]; then
    RESULTS_DIR="${candidate}"
  fi
done
if [ -n "${RESULTS_DIR}" ]; then
  cp -r "${RESULTS_DIR}" "${ARCHIVE}/vts-results/"
  echo "archived results: ${ARCHIVE}/vts-results/"
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
E1_NPU_PRESENT=false
if grep -R -q 'vendor\.eliza\.e1_npu\|e1_npu' "${ARCHIVE}" 2>/dev/null; then
  E1_NPU_PRESENT=true
fi
python3 - "${RESULT_JSON_PATH}" "${RESULT_STATUS}" "${TRADEFED_RC}" "${ARCHIVE}" "${E1_NPU_PRESENT}" <<'PY'
import json
import sys
from datetime import UTC, datetime

out, status, rc, archive, e1_npu_present = sys.argv[1:6]
payload = {
    "schema": "eliza.e1_npu_android_vts_smoke_result.v1",
    "status": status,
    "VTS_SCOPE": "e1_npu HAL manager, VINTF, binder, SELinux, kernel smoke",
    "e1_npu": e1_npu_present == "true",
    "archive": archive,
    "RESULT": int(rc),
    "RESULT=0": int(rc) == 0,
    "date_utc": datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    "claim_boundary": "vts_smoke_only_not_full_android_compatibility_claim",
}
with open(out, "w", encoding="utf-8") as f:
    json.dump(payload, f, indent=2, sort_keys=True)
    f.write("\n")
PY
echo "VTS smoke archive: ${ARCHIVE}"
echo "VTS smoke result: ${RESULT_JSON_PATH}"
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
