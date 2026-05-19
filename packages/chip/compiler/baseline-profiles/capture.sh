#!/usr/bin/env bash
# Capture an Android baseline profile from a Macrobenchmark run.
#
# Usage:
#   compiler/baseline-profiles/capture.sh \
#       --app <android-project-dir> \
#       --device-serial <adb-device> \
#       --output <baseline-prof.txt>
set -euo pipefail

app=""
device=""
output=""

while [ "$#" -gt 0 ]; do
    case "$1" in
        --app) app="$2"; shift 2 ;;
        --device-serial) device="$2"; shift 2 ;;
        --output) output="$2"; shift 2 ;;
        -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

emit_status() { printf 'STATUS: %s %s\n' "$1" "$2"; }

if ! command -v adb >/dev/null 2>&1; then
    emit_status "BLOCKED" "baseline.adb_missing"
    exit 2
fi
if [ -z "$app" ] || [ -z "$output" ]; then
    emit_status "FAIL" "baseline.usage"
    exit 2
fi

if [ -z "$device" ]; then
    device="$(adb devices | awk 'NR>1 && $2=="device" {print $1}' | head -1 || true)"
    if [ -z "$device" ]; then
        emit_status "BLOCKED" "baseline.no_device"
        exit 2
    fi
fi

if [ ! -x "$app/gradlew" ]; then
    emit_status "FAIL" "baseline.gradle_missing"
    echo "capture: $app/gradlew not executable" >&2
    exit 1
fi

ANDROID_SERIAL="$device" "$app/gradlew" -p "$app" \
    :app:generateBaselineProfile

profile="$app/app/build/intermediates/baselineProfile/release/baselineProfiles/baseline-prof.txt"
if [ ! -f "$profile" ]; then
    emit_status "FAIL" "baseline.profile_missing"
    echo "capture: $profile not produced by Macrobenchmark" >&2
    exit 1
fi
cp "$profile" "$output"
emit_status "PASS" "baseline.capture"
