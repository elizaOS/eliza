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
set +x

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
echo "VTS smoke archive: ${ARCHIVE}"
