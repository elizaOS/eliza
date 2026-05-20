#!/usr/bin/env bash
# adb-driven speaker probe for the Cuttlefish riscv64 device.
#
# Pushes a 1 s 440 Hz tone, plays it through the virtio-snd output via
# tinyplay, captures the virtio-snd loopback via tinycap, pulls the result,
# verifies the container, and FFT-checks the dominant spectral bin against
# 440 Hz to prove the loopback carried the played tone.
set -euo pipefail

component=speakers
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
tone_fixture="$here/fixtures/tone-440hz.wav"

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
command -v file >/dev/null 2>&1 || die "file(1) not on PATH" 2
command -v python3 >/dev/null 2>&1 || die "python3 not on PATH" 2
[ -f "$tone_fixture" ] || die "missing fixture: $tone_fixture (regenerate with fixtures/scripts/make-tone.py)" 2

emit "COMPONENT=${component}"
emit "AUDIO_OUTPUT=stereo_pcm"
emit "TONE_FIXTURE=$(basename "$tone_fixture")"

remote_tone=/sdcard/eliza-tone-440hz.wav
remote_loop=/sdcard/eliza-loopback.wav
adb_cmd shell rm -f "$remote_tone" "$remote_loop" >/dev/null 2>&1 || true
adb_cmd push "$tone_fixture" "$remote_tone" >/dev/null

# tinycap runs in the background while tinyplay drives the speaker; the
# virtio-snd loopback path feeds the same samples back to card 0 input.
adb_cmd shell "rm -f $remote_loop; tinycap $remote_loop -D 0 -d 0 -c 1 -r 16000 -b 16 2 &
sleep 0.2
tinyplay $remote_tone -D 0 -d 0
wait" >/dev/null 2>&1 || die "tinyplay/tinycap pipeline failed on device"

remote_bytes=$(adb_cmd shell "stat -c %s $remote_loop 2>/dev/null || wc -c < $remote_loop" | tr -d '\r ' || true)
if [ -z "$remote_bytes" ] || [ "$remote_bytes" -le 44 ]; then
	die "loopback capture missing or shorter than WAV header"
fi

tmpdir=${ELIZA_PERIPHERAL_TMPDIR:-$(mktemp -d)}
mkdir -p "$tmpdir"
host_path="$tmpdir/eliza-loopback.wav"
adb_cmd pull "$remote_loop" "$host_path" >/dev/null

file_desc=$(file -b "$host_path")
emit "FILE_DESC=$file_desc"
case "$file_desc" in
	"RIFF (little-endian) data, WAVE audio"*) ;;
	*) die "loopback capture is not RIFF/WAVE: $file_desc" ;;
esac

frame_bytes=$(wc -c < "$host_path" | tr -d ' ')
emit "FRAME_BYTES=$frame_bytes"

peak_hz=$(python3 - "$host_path" <<'PY'
import math
import struct
import sys
import wave

with wave.open(sys.argv[1], "rb") as w:
    if w.getsampwidth() != 2:
        raise SystemExit(f"unexpected sampwidth: {w.getsampwidth()}")
    rate = w.getframerate()
    nframes = w.getnframes()
    channels = w.getnchannels()
    frames = w.readframes(nframes)
samples = struct.unpack(f"<{len(frames)//2}h", frames)
if channels > 1:
    samples = samples[0::channels]
n = len(samples)
if n == 0:
    raise SystemExit("empty loopback")
mean = sum(samples) / n
xs = [s - mean for s in samples]

# Goertzel sweep over candidate frequencies; avoids requiring numpy on host.
def power(freq: float) -> float:
    coeff = 2.0 * math.cos(2.0 * math.pi * freq / rate)
    s_prev = 0.0
    s_prev2 = 0.0
    for x in xs:
        s = x + coeff * s_prev - s_prev2
        s_prev2 = s_prev
        s_prev = s
    return s_prev2 * s_prev2 + s_prev * s_prev - coeff * s_prev * s_prev2

best_freq = 0.0
best_power = -1.0
freq = 80.0
while freq <= min(rate / 2.0, 4000.0):
    p = power(freq)
    if p > best_power:
        best_power = p
        best_freq = freq
    freq += 5.0
print(f"{best_freq:.1f}")
PY
)
emit "LOOPBACK_PEAK_HZ=$peak_hz"

within=$(python3 -c "import sys;v=float(sys.argv[1]);print('ok' if abs(v-440.0)<=15.0 else 'off')" "$peak_hz")
[ "$within" = ok ] || die "loopback dominant bin ${peak_hz} Hz not within ±15 Hz of 440 Hz"
emit "LOOPBACK_VERIFIED=true"

emit "eliza-evidence: status=PASS COMPONENT=${component} LOOPBACK_PEAK_HZ=${peak_hz} FRAME_BYTES=${frame_bytes}"
exit 0
