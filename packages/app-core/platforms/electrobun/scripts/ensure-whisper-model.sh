#!/usr/bin/env bash
#
# Ensure the requested whisper.cpp model exists in both the working tree and the
# shared Milady cache. This is intentionally separate from the native binary
# build so CI can prepare the model once and fan it out to all desktop jobs.
#
# Usage:
#   bash apps/app/electrobun/scripts/ensure-whisper-model.sh [model]
#
set -euo pipefail

MODEL="${1:-base.en}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WHISPER_DIR="$(cd "$SCRIPT_DIR/../../../.." && pwd)/node_modules/whisper-node/lib/whisper.cpp"
WHISPER_MODEL_DIR="$WHISPER_DIR/models"
WHISPER_MODEL_FILENAME="ggml-${MODEL}.bin"
WHISPER_MODEL_PATH="$WHISPER_MODEL_DIR/$WHISPER_MODEL_FILENAME"
WHISPER_MODEL_CACHE_DIR="${MILADY_WHISPER_MODEL_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/milady/whisper}"
WHISPER_MODEL_CACHE_PATH="$WHISPER_MODEL_CACHE_DIR/$WHISPER_MODEL_FILENAME"
DOWNLOAD_ATTEMPTS="${MILADY_WHISPER_DOWNLOAD_ATTEMPTS:-4}"
RETRY_DELAY_SECONDS="${MILADY_WHISPER_DOWNLOAD_RETRY_DELAY_SECONDS:-15}"

if [ ! -d "$WHISPER_DIR" ]; then
  echo "Error: whisper.cpp not found at $WHISPER_DIR" >&2
  echo "Run 'bun install' first." >&2
  exit 1
fi

mkdir -p "$WHISPER_MODEL_DIR"
mkdir -p "$WHISPER_MODEL_CACHE_DIR"

if [ -f "$WHISPER_MODEL_PATH" ]; then
  echo "==> Whisper model already present: $WHISPER_MODEL_PATH"
elif [ -f "$WHISPER_MODEL_CACHE_PATH" ]; then
  echo "==> Restoring whisper model from cache: $WHISPER_MODEL_CACHE_PATH"
  cp "$WHISPER_MODEL_CACHE_PATH" "$WHISPER_MODEL_PATH"
else
  cd "$WHISPER_DIR"

  for attempt in $(seq 1 "$DOWNLOAD_ATTEMPTS"); do
    echo "==> Downloading model attempt ${attempt}/${DOWNLOAD_ATTEMPTS}: $WHISPER_MODEL_FILENAME"
    rm -f "$WHISPER_MODEL_PATH"

    if bash models/download-ggml-model.sh "$MODEL"; then
      break
    fi

    if [ "$attempt" -eq "$DOWNLOAD_ATTEMPTS" ]; then
      echo "Error: failed to download $WHISPER_MODEL_FILENAME after ${DOWNLOAD_ATTEMPTS} attempts" >&2
      exit 1
    fi

    echo "==> Download failed; retrying in ${RETRY_DELAY_SECONDS}s" >&2
    sleep "$RETRY_DELAY_SECONDS"
  done
fi

if [ ! -f "$WHISPER_MODEL_PATH" ]; then
  echo "Error: whisper model missing after restore/download: $WHISPER_MODEL_PATH" >&2
  exit 1
fi

cp "$WHISPER_MODEL_PATH" "$WHISPER_MODEL_CACHE_PATH"

echo "==> Whisper model ready: $WHISPER_MODEL_PATH"
echo "    Cache: $WHISPER_MODEL_CACHE_PATH"
