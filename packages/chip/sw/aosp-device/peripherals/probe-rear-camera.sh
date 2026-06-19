#!/usr/bin/env bash
# adb-driven rear-camera probe for the Cuttlefish riscv64 device.
#
# Drives the simulated rear sensor through Android's `cmd media.camera`
# surface, opens the still-image camera app, triggers a capture, and pulls
# the resulting frame off /sdcard/DCIM/Camera/ for `file` verification.
#
# Required env:
#   ADB_SERIAL  (optional) — passes `adb -s <serial>` when set.
# Optional env:
#   ELIZA_PERIPHERAL_TMPDIR — host scratch dir for pulled frames (default: mktemp).
#
# Emits eliza-evidence-friendly KEY=VALUE markers to stdout. Exits 0 on PASS,
# 1 on any assertion failure, 2 on environment/tooling failure.
set -euo pipefail

component=rear_camera
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)

emit() { printf '%s\n' "$*"; }

die() {
	code=${2:-1}
	emit "PROBE_ERROR=$*"
	if [ "$code" -eq 2 ]; then
		emit "eliza-evidence: status=BLOCKED COMPONENT=${component}"
	else
		emit "eliza-evidence: status=FAIL COMPONENT=${component}"
	fi
	exit "$code"
}

# shellcheck source=./probe-common.sh
# shellcheck disable=SC1091
. "$here/probe-common.sh"
require_adb_device
require_android_boot_completed
command -v file >/dev/null 2>&1 || die "file(1) not on PATH" 2

emit "COMPONENT=${component}"
emit "FRAME_SOURCE=simulated_sensor"

camera_ids_raw=$(adb_cmd shell cmd media.camera get-camera-ids 2>&1 | tr -d '\r')
emit "CAMERA_IDS_RAW<<EOF"
emit "$camera_ids_raw"
emit "EOF"

# `cmd media.camera get-camera-ids` prints lines like "Camera 0: ...".
# Treat lens-facing 0 (back) as the rear camera ID.
rear_id=$(printf '%s\n' "$camera_ids_raw" \
	| awk '/LENS_FACING_BACK/ {print prev_id; exit} /^Camera [0-9]+/ {prev_id=$2; gsub(":", "", prev_id)}')
if [ -z "$rear_id" ]; then
	# Fallback: take the first reported ID.
	rear_id=$(printf '%s\n' "$camera_ids_raw" \
		| awk '/^Camera [0-9]+/ {gsub(":", "", $2); print $2; exit}')
fi
[ -n "$rear_id" ] || die "no camera id returned by cmd media.camera get-camera-ids"
emit "CAMERA_ID=$rear_id"

camera_count=$(printf '%s\n' "$camera_ids_raw" | awk '/^Camera [0-9]+/ {n++} END {print n+0}')
[ "$camera_count" -ge 1 ] || die "expected >=1 camera id, got $camera_count"
emit "CAMERA_COUNT=$camera_count"

# Snapshot pre-capture file list so we can detect the new frame after the shutter.
before=$(adb_cmd shell 'ls -1 /sdcard/DCIM/Camera/ 2>/dev/null' | tr -d '\r' | sort)

adb_cmd shell am start -a android.media.action.STILL_IMAGE_CAMERA >/dev/null
# Allow the camera app to wire up to the HAL.
sleep 3

# Two captures so we exercise the simulated sensor twice (matches the
# CAPTURE_COUNT=2 contract on the completion gate).
adb_cmd shell input keyevent KEYCODE_CAMERA >/dev/null
sleep 2
adb_cmd shell input keyevent KEYCODE_CAMERA >/dev/null
sleep 3

after=$(adb_cmd shell 'ls -1 /sdcard/DCIM/Camera/ 2>/dev/null' | tr -d '\r' | sort)
new_files=$(comm -13 <(printf '%s\n' "$before") <(printf '%s\n' "$after") | grep -E '\.(jpg|jpeg|png)$' || true)
capture_count=$(printf '%s\n' "$new_files" | grep -c . || true)
[ "$capture_count" -ge 2 ] || die "expected 2 new captures, got $capture_count"
emit "CAPTURE_COUNT=$capture_count"

tmpdir=${ELIZA_PERIPHERAL_TMPDIR:-$(mktemp -d)}
mkdir -p "$tmpdir"
latest=$(printf '%s\n' "$new_files" | tail -n1)
[ -n "$latest" ] || die "could not identify newest captured frame"
adb_cmd pull "/sdcard/DCIM/Camera/$latest" "$tmpdir/$latest" >/dev/null
host_path="$tmpdir/$latest"
file_desc=$(file -b "$host_path")
case "$file_desc" in
	"JPEG image data"*|"PNG image data"*) ;;
	*) die "frame is not JPEG/PNG: $file_desc" ;;
esac
frame_bytes=$(wc -c < "$host_path" | tr -d ' ')
[ "$frame_bytes" -gt 0 ] || die "frame is zero bytes"
emit "FRAME_FILE=$latest"
emit "FRAME_BYTES=$frame_bytes"
emit "FRAME_KIND=${file_desc%%,*}"

emit "eliza-evidence: status=PASS COMPONENT=${component} CAMERA_ID=${rear_id} FRAME_BYTES=${frame_bytes}"
exit 0
