#!/usr/bin/env bash
# Android / Light Phone III pendant walk evidence capture.
#
# Usage:
#   APP_ID=ai.elizaos.app \
#   OUT=.github/issue-evidence/15744-pendant-lightphone-performance-android-walk \
#   DURATION_SECONDS=600 SAMPLE_INTERVAL_SECONDS=60 \
#   ./15744-pendant-lightphone-performance-android-walk.sh
#
# Requirements: adb on PATH, current APK installed, pendant paired/ready, one
# target device selected by adb or ANDROID_SERIAL.

set -euo pipefail

APP_ID="${APP_ID:-ai.elizaos.app}"
OUT="${OUT:-.github/issue-evidence/15744-pendant-lightphone-performance-android-walk}"
DURATION_SECONDS="${DURATION_SECONDS:-600}"
SAMPLE_INTERVAL_SECONDS="${SAMPLE_INTERVAL_SECONDS:-60}"

if [[ ! "$DURATION_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "DURATION_SECONDS must be a positive integer" >&2
  exit 2
fi
if [[ ! "$SAMPLE_INTERVAL_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "SAMPLE_INTERVAL_SECONDS must be a positive integer" >&2
  exit 2
fi

mkdir -p "$OUT/samples"

LOGCAT_PID=""
cleanup() {
  if [[ -n "$LOGCAT_PID" ]]; then
    kill "$LOGCAT_PID" 2>/dev/null || true
    wait "$LOGCAT_PID" 2>/dev/null || true
    LOGCAT_PID=""
  fi
}
trap cleanup EXIT

capture_sample() {
  local sequence="$1"
  local elapsed="$2"
  local prefix
  prefix=$(printf '%s/samples/%03d-%06ds' "$OUT" "$sequence" "$elapsed")
  date --utc --iso-8601=seconds >"$prefix.timestamp.txt"
  adb shell dumpsys battery >"$prefix.battery.txt"
  adb shell dumpsys meminfo "$APP_ID" >"$prefix.meminfo.txt"
  adb shell dumpsys thermalservice >"$prefix.thermal.txt" 2>&1 || true
  adb shell top -b -n 1 -o PID,USER,CPU,RES,ARGS >"$prefix.top.txt" 2>&1 || true
}

adb get-state >"$OUT/adb-state.txt"
adb shell getprop ro.product.model >"$OUT/device-model.txt"
adb shell getprop ro.build.fingerprint >"$OUT/build-fingerprint.txt"
adb shell dumpsys package "$APP_ID" >"$OUT/package-before.txt"
adb shell pm path "$APP_ID" >"$OUT/package-paths.txt"
: >"$OUT/package-sha256.txt"
while IFS= read -r package_line; do
  package_path="${package_line#package:}"
  package_path="${package_path//$'\r'/}"
  if [[ -n "$package_path" ]]; then
    adb shell sha256sum "$package_path" >>"$OUT/package-sha256.txt" 2>&1 || true
  fi
done <"$OUT/package-paths.txt"
adb shell dumpsys battery >"$OUT/battery-before.txt"
adb shell dumpsys batterystats --reset >"$OUT/batterystats-reset.txt"
adb shell dumpsys meminfo "$APP_ID" >"$OUT/meminfo-before.txt"
adb shell dumpsys thermalservice >"$OUT/thermal-before.txt" 2>&1 || true
adb shell top -b -n 1 -o PID,USER,CPU,RES,ARGS >"$OUT/top-before.txt" 2>&1 || true
adb logcat -c

adb logcat -v threadtime \
  '*:S' \
  'Eliza*:V' \
  'Capacitor*:I' \
  'BluetoothLe*:V' \
  'BluetoothGatt*:I' \
  'bt_stack:I' \
  'chromium:I' \
  >"$OUT/logcat-filtered.txt" &
LOGCAT_PID=$!

START_EPOCH=$(date +%s)
sequence=0
while true; do
  now=$(date +%s)
  elapsed=$((now - START_EPOCH))
  if (( elapsed >= DURATION_SECONDS )); then
    break
  fi
  capture_sample "$sequence" "$elapsed"
  sequence=$((sequence + 1))
  now=$(date +%s)
  remaining=$((DURATION_SECONDS - (now - START_EPOCH)))
  if (( remaining <= 0 )); then
    break
  fi
  sleep_for="$SAMPLE_INTERVAL_SECONDS"
  if (( remaining < sleep_for )); then
    sleep_for="$remaining"
  fi
  sleep "$sleep_for"
done
capture_sample "$sequence" "$(( $(date +%s) - START_EPOCH ))"

cleanup

adb shell dumpsys battery >"$OUT/battery-after.txt"
adb shell dumpsys meminfo "$APP_ID" >"$OUT/meminfo-after.txt"
adb shell dumpsys batterystats "$APP_ID" >"$OUT/batterystats-after.txt" 2>&1 || adb shell dumpsys batterystats >"$OUT/batterystats-after.txt"
adb shell dumpsys thermalservice >"$OUT/thermal-after.txt" 2>&1 || true
adb shell top -b -n 1 -o PID,USER,CPU,RES,ARGS >"$OUT/top-after.txt" 2>&1 || true
adb shell dumpsys bluetooth_manager >"$OUT/bluetooth-manager-after.txt" 2>&1 || true
adb shell dumpsys wifi >"$OUT/radio-wifi-after.txt" 2>&1 || true
adb shell dumpsys telephony.registry >"$OUT/radio-telephony-after.txt" 2>&1 || true
adb shell dumpsys connectivity >"$OUT/radio-connectivity-after.txt" 2>&1 || true
adb bugreport "$OUT/bugreport.zip" >/dev/null 2>&1 || true

cat >"$OUT/README.md" <<EOF
# Issue #15744 Android / LP3 Pendant Walk Evidence

- App id: \`$APP_ID\`
- Configured duration seconds: \`$DURATION_SECONDS\`
- Periodic sample interval seconds: \`$SAMPLE_INTERVAL_SECONDS\`
- Captured: package paths/hashes, periodic LP3 meminfo/battery/thermal/CPU,
  batterystats, Bluetooth/radio dumps, filtered logcat, and optional bugreport.
- Android thermal and battery files describe the LP3, not the pendant. Record
  pendant BAS percentage and case temperature manually using the battery/thermal
  runbook.
- Manual review required: confirm package identity, actual pendant activity in
  logcat, bounded memory, acceptable LP3 thermal state, and representative radio
  use. An integer ten-minute battery percentage delta is directional only.
- E2E handoff: attach this directory to the E2E lane artifact bundle after its
  walkthrough. This script intentionally does not edit E2E-owned files.
EOF

trap - EXIT
