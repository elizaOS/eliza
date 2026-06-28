#!/usr/bin/env bash
# Real-audio detection verification for the shipped eliza-1 "hey eliza" wake head
# (issue #9880). Builds the standalone wakeword-cpp runtime, then scores piper-TTS
# (in-distribution) speech through it: positives ("hey eliza") must fire high,
# negatives must stay low.
#
# Prereqs: cmake, ffmpeg, and a piper-tts venv + an en_US piper voice:
#   python3 -m venv piperenv && ./piperenv/bin/pip install piper-tts
#   curl -sL -o amy.onnx      https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx
#   curl -sL -o amy.onnx.json  https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx.json
# and the three v0.3.0 GGUFs (sha-verified against the catalog) in $GGUF_DIR.
#
# Env: GGUF_DIR, PIPER_VENV, PIPER_VOICE, ESPEAK_DATA_PATH (e.g.
#   /opt/homebrew/share/espeak-ng-data on macOS/brew).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
WW="$REPO/packages/native/plugins/wakeword-cpp"
GGUF_DIR="${GGUF_DIR:?set GGUF_DIR to the dir holding hey-eliza.{melspec,embedding,classifier}.gguf}"
PIPER="${PIPER_VENV:?set PIPER_VENV}/bin/python"
VOICE="${PIPER_VOICE:?set PIPER_VOICE to the piper .onnx}"

cmake -B "$WW/build" -S "$WW" >/dev/null
cmake --build "$WW/build" -j --target wakeword_score_raw >/dev/null
SC="$WW/build/wakeword_score_raw"
TMP="$(mktemp -d)"

score() { # phrase
  echo "$1" | "$PIPER" -m "$VOICE" -f "$TMP/ph.wav" 2>/dev/null
  # 2.5 s leading + 1 s trailing silence so the streaming mel/embedding rings
  # warm up (~1.9 s) and the post-phrase detection latency can peak.
  ffmpeg -y -loglevel error \
    -f lavfi -t 2.5 -i anullsrc=r=22050:cl=mono \
    -i "$TMP/ph.wav" \
    -f lavfi -t 1.0 -i anullsrc=r=22050:cl=mono \
    -filter_complex "[0][1][2]concat=n=3:v=0:a=1" \
    -ar 16000 -ac 1 -f f32le "$TMP/p.f32" 2>/dev/null
  printf "%-16s %s\n" "\"$1\"" \
    "$("$SC" "$GGUF_DIR/hey-eliza.melspec.gguf" "$GGUF_DIR/hey-eliza.embedding.gguf" "$GGUF_DIR/hey-eliza.classifier.gguf" "$TMP/p.f32")"
}

echo "=== POSITIVES (must fire) ==="
for p in "hey eliza" "hey, Eliza." "okay eliza" "eliza"; do score "$p"; done
echo "=== NEGATIVES (must stay low) ==="
for p in "hey alyssa" "okay computer" "what time is it"; do score "$p"; done
rm -rf "$TMP"
