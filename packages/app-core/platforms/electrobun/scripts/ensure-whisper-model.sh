#!/usr/bin/env bash
set -euo pipefail

MODEL_NAME="${1:-base.en}"
MODEL_FILE="ggml-${MODEL_NAME}.bin"
CACHE_DIR="${ELIZA_WHISPER_CACHE_DIR:-$HOME/.cache/eliza/whisper}"
MODEL_PATH="$CACHE_DIR/$MODEL_FILE"
MODEL_URL="${ELIZA_WHISPER_MODEL_URL:-https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$MODEL_FILE}"

mkdir -p "$CACHE_DIR"

if [[ -s "$MODEL_PATH" ]]; then
  echo "Whisper model already cached at $MODEL_PATH"
  exit 0
fi

TMP_PATH="$MODEL_PATH.tmp"
rm -f "$TMP_PATH"

echo "Downloading Whisper model $MODEL_NAME from $MODEL_URL"
curl --fail --location --retry 3 --retry-delay 5 --output "$TMP_PATH" "$MODEL_URL"

if [[ ! -s "$TMP_PATH" ]]; then
  echo "Downloaded Whisper model is empty: $TMP_PATH" >&2
  exit 1
fi

mv "$TMP_PATH" "$MODEL_PATH"
echo "Cached Whisper model at $MODEL_PATH"
