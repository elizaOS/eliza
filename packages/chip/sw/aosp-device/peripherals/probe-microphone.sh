#!/usr/bin/env bash
# adb-driven microphone probe for the Cuttlefish riscv64 device.
#
# Captures 1 s of PCM via `tinycap` against the virtio-snd input, pulls the
# WAV to the host, verifies the container with `file(1)`, and computes the
# signed-16 LE RMS to confirm non-silent stimulus (CVD supplies a sine-wave
# test tone on the simulated mic).
set -euo pipefail

component=microphone
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
command -v python3 >/dev/null 2>&1 || die "python3 not on PATH" 2

emit "COMPONENT=${component}"
emit "AUDIO_CAPTURE=pcm_s16le"

device_path=/sdcard/eliza-mic.wav
adb_cmd shell rm -f "$device_path" >/dev/null 2>&1 || true

# tinycap writes a RIFF/WAVE file; -D 0 -d 0 selects card 0 device 0, -c 1
# is mono, -r 16000 is 16 kHz, -b 16 is 16-bit signed PCM. The trailing
# duration argument is in seconds.
capture_log=$(adb_cmd shell "tinycap $device_path -D 0 -d 0 -c 1 -r 16000 -b 16 1" 2>&1 | tr -d '\r' || true)
emit "TINYCAP_LOG<<EOF"
emit "$capture_log"
emit "EOF"

remote_bytes=$(adb_cmd shell "stat -c %s $device_path 2>/dev/null || wc -c < $device_path" | tr -d '\r ' || true)
[ -n "$remote_bytes" ] && [ "$remote_bytes" -gt 44 ] || die "capture file missing or smaller than WAV header"

tmpdir=${ELIZA_PERIPHERAL_TMPDIR:-$(mktemp -d)}
mkdir -p "$tmpdir"
host_path="$tmpdir/eliza-mic.wav"
adb_cmd pull "$device_path" "$host_path" >/dev/null

file_desc=$(file -b "$host_path")
emit "FILE_DESC=$file_desc"
case "$file_desc" in
	"RIFF (little-endian) data, WAVE audio"*) ;;
	*) die "capture is not RIFF/WAVE: $file_desc" ;;
esac

frame_bytes=$(wc -c < "$host_path" | tr -d ' ')
emit "FRAME_BYTES=$frame_bytes"

rms_dbfs=$(python3 - "$host_path" <<'PY'
import math
import struct
import sys
import wave

with wave.open(sys.argv[1], "rb") as w:
    if w.getsampwidth() != 2:
        raise SystemExit(f"unexpected sampwidth: {w.getsampwidth()}")
    frames = w.readframes(w.getnframes())
samples = struct.unpack(f"<{len(frames)//2}h", frames)
if not samples:
    raise SystemExit("empty capture")
sumsq = sum(s * s for s in samples)
rms = math.sqrt(sumsq / len(samples))
if rms <= 0.0:
    print("-inf")
else:
    print(f"{20.0 * math.log10(rms / 32768.0):.2f}")
PY
)
emit "INPUT_RMS_DBFS=$rms_dbfs"

case "$rms_dbfs" in
	-inf|0|0.00) die "capture RMS is zero — virtio-snd mic not driving samples (got $rms_dbfs)" ;;
esac

# Reject RMS below the -90 dBFS floor: signed-16 quantization noise alone
# averages roughly -90 dBFS, so anything quieter is dead silence.
floor_check=$(python3 -c "import sys;v=sys.argv[1];print('ok' if float(v) > -90.0 else 'low')" "$rms_dbfs")
[ "$floor_check" = ok ] || die "capture RMS=$rms_dbfs dBFS below -90 dBFS floor"

emit "eliza-evidence: status=PASS COMPONENT=${component} INPUT_RMS_DBFS=${rms_dbfs} FRAME_BYTES=${frame_bytes}"
exit 0
