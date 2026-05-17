#!/usr/bin/env bash
# Convenience wrapper: run the LoRA recipe on an LJSpeech-format directory.
#
#   bash scripts/kokoro/jobs/finetune_default_voice.sh /path/to/LJSpeech-1.1
#
# Outputs land under /tmp/kokoro-runs/<voice_name>/. Override via env vars:
#   KOKORO_VOICE_NAME, KOKORO_OUTPUT_DIR, KOKORO_CONFIG.

set -euo pipefail
DATA_DIR="${1:-}"
if [ -z "$DATA_DIR" ]; then
  echo "usage: $0 <ljspeech-dir>" >&2
  exit 2
fi

VOICE_NAME="${KOKORO_VOICE_NAME:-eliza_custom}"
OUTPUT_DIR="${KOKORO_OUTPUT_DIR:-/tmp/kokoro-runs/$VOICE_NAME}"
CONFIG="${KOKORO_CONFIG:-kokoro_lora_ljspeech.yaml}"

HERE="$(cd "$(dirname "$0")/.." && pwd)"
bash "$HERE/run_finetune.sh" \
  --data-dir "$DATA_DIR" \
  --voice-name "$VOICE_NAME" \
  --config "$CONFIG" \
  --output-dir "$OUTPUT_DIR"
