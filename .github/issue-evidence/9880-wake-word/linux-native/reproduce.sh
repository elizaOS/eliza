#!/usr/bin/env bash
# Linux-native real-audio openWakeWord verification for elizaOS #9880 ("hey eliza").
# Reproduces the build + scoring on an x86_64 host. No git tree is touched.
set -euo pipefail

SRC=/home/shaw/eliza/eliza/packages/native/plugins/wakeword-cpp
WAKE=/home/shaw/.local/state/eliza/local-inference/wake          # 3 staged GGUFs (v0.3.0)
BASE=/tmp/claude-1000/-home-shaw-eliza-eliza/0f9d78ee-be57-4a92-a2d4-d61de93eed6b/scratchpad
BUILD=$BASE/wakeword-build
EVID=$BASE/9880-linux-wakeword
AUDIO=$EVID/audio
PIPER_MODEL=$BASE/piper-voices/en_US-amy-medium.onnx   # rhasspy/piper-voices en_US-amy-medium

MEL="$WAKE/hey-eliza.melspec.gguf"
EMB="$WAKE/hey-eliza.embedding.gguf"
CLS="$WAKE/hey-eliza.classifier.gguf"

# 1. Build (Release) into a scratch dir — NEVER inside the git tree.
cmake -B "$BUILD" -S "$SRC" -DCMAKE_BUILD_TYPE=Release
cmake --build "$BUILD" -j

# 2. Synthesize a clip -> 16 kHz mono f32le with 2.5 s lead-in + 1 s trailing
#    silence (the streaming runtime needs ~1.9 s warm-up to fill the mel+embedding
#    rings, and the score peaks ~0.5-1 s AFTER the phrase).
mkdir -p "$AUDIO"
synth () {  # synth "<text>" <slug>
  echo "$1" | piper -m "$PIPER_MODEL" -f "$AUDIO/$2.raw.wav" 2>/dev/null
  ffmpeg -y -loglevel error -i "$AUDIO/$2.raw.wav" -ac 1 \
    -af "adelay=2500,apad=pad_dur=1.0" -ar 16000 -f f32le "$AUDIO/$2.f32"
}
synth "hey eliza"                pos_hey_eliza
synth "hey jarvis"               neg_hey_jarvis     # hard negative (different wake word)
synth "what is the weather today" neg_weather
synth "turn on the lights"       neg_lights
ffmpeg -y -loglevel error -f lavfi -i "anullsrc=r=16000:cl=mono" -t 4 -f f32le "$AUDIO/neg_silence.f32"

# 3a. Peak score over the stream (the shipped harness, test/wakeword_score_raw.c).
for c in pos_hey_eliza neg_hey_jarvis neg_weather neg_lights neg_silence; do
  printf "%-18s peak=%s\n" "$c" "$("$BUILD/wakeword_score_raw" "$MEL" "$EMB" "$CLS" "$AUDIO/$c.f32")"
done

# 3b. Trajectory + max consecutive run >= threshold (production debounce metric).
#     wakeword_trace.c lives in the build dir; build it once:
gcc -O2 -I"$SRC/include" "$BUILD/wakeword_trace.c" "$BUILD/libwakeword.a" -lm -o "$BUILD/wakeword_trace"
for c in pos_hey_eliza neg_hey_jarvis neg_weather neg_lights neg_silence; do
  printf "%-18s %s\n" "$c" "$("$BUILD/wakeword_trace" "$MEL" "$EMB" "$CLS" "$AUDIO/$c.f32")"
done
