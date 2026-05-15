#!/usr/bin/env bash
# scripts/voice-kokoro/smoke.sh — J2 verification harness.
#
# Builds the fork-side `kokoro-tts` CLI and synthesizes a fixed prompt
# through the standalone Kokoro inference path. Exits 0 iff the produced
# WAV has peak amplitude > 1e-6 (i.e. is non-blank audio).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FORK_DIR="$REPO_ROOT/plugins/plugin-local-inference/native/llama.cpp"
BUILD_DIR="$FORK_DIR/build/linux-x64-cpu-fused"
OUT_DIR="${OUT_DIR:-/tmp/voice-kokoro-smoke}"
mkdir -p "$OUT_DIR"

echo "[smoke] repo root: $REPO_ROOT"
echo "[smoke] fork dir:  $FORK_DIR"

if [ ! -x "$BUILD_DIR/bin/kokoro-tts" ]; then
    echo "[smoke] building kokoro-tts..."
    cmake -DLLAMA_BUILD_KOKORO=ON "$BUILD_DIR" >/dev/null
    cmake --build "$BUILD_DIR" --target kokoro-tts -- -j 8
fi

GGUF="$OUT_DIR/kokoro-stub.gguf"
VOICE="$OUT_DIR/af_test.bin"
WAV="$OUT_DIR/kokoro-out.wav"

if [ ! -s "$GGUF" ]; then
    echo "[smoke] producing stub GGUF..."
    python3 "$FORK_DIR/tools/kokoro/convert_kokoro_pth_to_gguf.py" --stub --output "$GGUF"
fi

if [ ! -s "$VOICE" ]; then
    echo "[smoke] producing voice preset..."
    python3 -c "
import numpy as np
np.random.default_rng(seed=11).standard_normal((510, 1, 256)).astype(np.float32).tofile('$VOICE')
"
fi

echo "[smoke] running kokoro-tts..."
"$BUILD_DIR/bin/kokoro-tts" \
    --model "$GGUF" \
    --voice "$VOICE" \
    --text "Hello world. This is a J2 verification of the fork-side Kokoro path." \
    --output "$WAV"

# Peak check via Python (cheap; we already depend on numpy for the stub gen).
python3 -c "
import struct, sys
with open('$WAV', 'rb') as f:
    data = f.read()
# Crude WAV peak: skip 44-byte header, treat rest as int16 LE.
import array
samples = array.array('h')
samples.frombytes(data[44:])
peak = max(abs(s) for s in samples) if samples else 0
print(f'[smoke] peak int16={peak}/32767  samples={len(samples)}')
sys.exit(0 if peak > 0 else 1)
"

echo "[smoke] PASS — non-blank WAV at $WAV"
