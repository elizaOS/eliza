#!/usr/bin/env bash
# Fetch a ggml-format whisper.cpp model from HuggingFace.
#
# Replaces the previous OpenVINO IR install path. The whisper.cpp ggml
# format is the on-disk representation our libwhisper_eliza_adapter loads
# via the upstream `whisper_init_from_file_with_params` entrypoint — it's
# the same file ggerganov/whisper.cpp ships at
# https://huggingface.co/ggerganov/whisper.cpp.
#
# Usage:
#   bash ensure-whisper-gguf.sh [model_name]
#     model_name defaults to "base.en". Recognised names match upstream:
#       tiny[.en], base[.en], small[.en], medium[.en], large-v1, large-v2,
#       large-v3, large-v3-turbo[-q5_0].
#
# Env knobs:
#   ELIZA_WHISPER_MODEL_DIR   override download cache root
#                             (default: ~/.cache/eliza/whisper)
#   ELIZA_WHISPER_MODEL_URL   override download URL (default:
#                             https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${MODEL_NAME}.bin)
#
# Exit codes:
#   0  - model already present or downloaded successfully
#   1  - download tool missing or fetch failed
#   2  - unknown / unsupported model name (best-effort: only fails when
#        the resolved URL returns 404 because the file does not exist)
set -euo pipefail

MODEL_NAME="${1:-base.en}"
CACHE_DIR="${ELIZA_WHISPER_MODEL_DIR:-$HOME/.cache/eliza/whisper}"
MODEL_FILE="$CACHE_DIR/ggml-${MODEL_NAME}.bin"
MODEL_URL="${ELIZA_WHISPER_MODEL_URL:-https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${MODEL_NAME}.bin}"

mkdir -p "$CACHE_DIR"

if [[ -s "$MODEL_FILE" ]]; then
  echo "Whisper GGUF/GGML model already present: $MODEL_FILE"
  exit 0
fi

TMP_FILE="${MODEL_FILE}.tmp"
rm -f "$TMP_FILE"

echo "Downloading whisper.cpp ggml model ${MODEL_NAME}..."
if command -v curl >/dev/null 2>&1; then
  curl --fail --location --retry 3 --output "$TMP_FILE" "$MODEL_URL"
elif command -v wget >/dev/null 2>&1; then
  wget --tries=3 --output-document="$TMP_FILE" "$MODEL_URL"
else
  echo "curl or wget is required to download $MODEL_URL" >&2
  exit 1
fi

mv "$TMP_FILE" "$MODEL_FILE"
echo "Whisper GGUF/GGML model ready: $MODEL_FILE"
