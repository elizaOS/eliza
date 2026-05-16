#!/usr/bin/env bash
set -euo pipefail

MODEL_NAME="${1:-base.en}"
CACHE_DIR="${ELIZA_WHISPER_MODEL_DIR:-$HOME/.cache/eliza/whisper}"
MODEL_FILE="$CACHE_DIR/ggml-${MODEL_NAME}.bin"
MODEL_URL="${ELIZA_WHISPER_MODEL_URL:-https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${MODEL_NAME}.bin}"

mkdir -p "$CACHE_DIR"

if [[ -s "$MODEL_FILE" ]]; then
  echo "Whisper model already present: $MODEL_FILE"
  exit 0
fi

TMP_FILE="${MODEL_FILE}.tmp"
rm -f "$TMP_FILE"

echo "Downloading Whisper model ${MODEL_NAME}..."
if command -v curl >/dev/null 2>&1; then
  curl --fail --location --retry 3 --output "$TMP_FILE" "$MODEL_URL"
elif command -v wget >/dev/null 2>&1; then
  wget --tries=3 --output-document="$TMP_FILE" "$MODEL_URL"
else
  echo "curl or wget is required to download $MODEL_URL" >&2
  exit 1
fi

mv "$TMP_FILE" "$MODEL_FILE"
echo "Whisper model ready: $MODEL_FILE"
