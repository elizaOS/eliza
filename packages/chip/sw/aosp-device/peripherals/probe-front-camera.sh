#!/usr/bin/env bash
# adb-driven front-camera probe for the Cuttlefish riscv64 device.
#
# Same flow as probe-rear-camera.sh but selects LENS_FACING_FRONT and asserts
# the chosen front camera ID differs from the rear sensor's ID.
set -euo pipefail

component=front_camera
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

. "$here/probe-common.sh"
require_adb_device
command -v file >/dev/null 2>&1 || die "file(1) not on PATH" 2

emit "COMPONENT=${component}"
emit "FRAME_SOURCE=simulated_sensor"

camera_ids_raw=$(adb_cmd shell cmd media.camera get-camera-ids 2>&1 | tr -d '\r')
emit "CAMERA_IDS_RAW<<EOF"
emit "$camera_ids_raw"
emit "EOF"

front_id=$(printf '%s\n' "$camera_ids_raw" \
	| awk '/LENS_FACING_FRONT/ {print prev_id; exit} /^Camera [0-9]+/ {prev_id=$2; gsub(":", "", prev_id)}')
rear_id=$(printf '%s\n' "$camera_ids_raw" \
	| awk '/LENS_FACING_BACK/ {print prev_id; exit} /^Camera [0-9]+/ {prev_id=$2; gsub(":", "", prev_id)}')
if [ -z "$front_id" ]; then
	# Fallback: take the second reported ID if the lens-facing tag is missing.
	front_id=$(printf '%s\n' "$camera_ids_raw" \
		| awk '/^Camera [0-9]+/ {gsub(":", "", $2); print $2}' | sed -n '2p')
fi
[ -n "$front_id" ] || die "no front camera id resolved from cmd media.camera"
emit "CAMERA_ID=$front_id"
if [ -n "$rear_id" ]; then
	emit "REAR_CAMERA_ID=$rear_id"
	[ "$rear_id" != "$front_id" ] || die "front camera id collides with rear: $front_id"
fi

camera_count=$(printf '%s\n' "$camera_ids_raw" | awk '/^Camera [0-9]+/ {n++} END {print n+0}')
[ "$camera_count" -ge 1 ] || die "expected >=1 camera id, got $camera_count"
emit "CAMERA_COUNT=$camera_count"

before=$(adb_cmd shell 'ls -1 /sdcard/DCIM/Camera/ 2>/dev/null' | tr -d '\r' | sort)

# Some camera apps interpret --ei android.intent.extras.CAMERA_FACING 1 as front;
# the still-image intent on Cuttlefish honors it.
adb_cmd shell am start -a android.media.action.STILL_IMAGE_CAMERA \
	--ei android.intent.extras.CAMERA_FACING 1 \
	--ei android.intent.extras.LENS_FACING_FRONT 1 \
	--ei android.intent.extras.USE_FRONT_CAMERA 1 >/dev/null
sleep 3

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

emit "eliza-evidence: status=PASS COMPONENT=${component} CAMERA_ID=${front_id} FRAME_BYTES=${frame_bytes}"
exit 0
