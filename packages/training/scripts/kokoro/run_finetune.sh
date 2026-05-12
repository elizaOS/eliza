#!/usr/bin/env bash
# Kokoro fine-tune end-to-end: prep → train → extract embedding → export → eval → package.
#
# Usage:
#   bash scripts/kokoro/run_finetune.sh \
#       --data-dir /path/to/LJSpeech-1.1 \
#       --voice-name my_voice \
#       --config kokoro_lora_ljspeech.yaml \
#       --output-dir /tmp/kokoro-runs/my_voice
#
# Use `--synthetic-smoke` for a no-GPU pipeline shape check. The smoke variant
# is what CI runs.

set -euo pipefail

DATA_DIR=""
VOICE_NAME=""
CONFIG="kokoro_lora_ljspeech.yaml"
OUTPUT_DIR=""
RELEASE_DIR=""
SYNTHETIC_SMOKE=0
PYTHON_BIN="${PYTHON_BIN:-python3}"
ALLOW_GATE_FAIL=0

usage() {
  sed -n '2,16p' "$0"
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    --voice-name) VOICE_NAME="$2"; shift 2 ;;
    --config) CONFIG="$2"; shift 2 ;;
    --output-dir) OUTPUT_DIR="$2"; shift 2 ;;
    --release-dir) RELEASE_DIR="$2"; shift 2 ;;
    --synthetic-smoke) SYNTHETIC_SMOKE=1; shift ;;
    --allow-gate-fail) ALLOW_GATE_FAIL=1; shift ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done

if [ -z "$OUTPUT_DIR" ]; then
  echo "--output-dir is required" >&2
  exit 2
fi
if [ -z "$VOICE_NAME" ]; then
  VOICE_NAME="eliza_custom"
fi
if [ -z "$RELEASE_DIR" ]; then
  RELEASE_DIR="$OUTPUT_DIR/release"
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$OUTPUT_DIR"

SMOKE_FLAG=""
if [ "$SYNTHETIC_SMOKE" -eq 1 ]; then
  SMOKE_FLAG="--synthetic-smoke"
fi

ALLOW_FAIL_FLAG=""
if [ "$ALLOW_GATE_FAIL" -eq 1 ]; then
  ALLOW_FAIL_FLAG="--allow-gate-fail"
fi

echo "== prep =="
PREP_CMD=("$PYTHON_BIN" "$HERE/prep_ljspeech.py" --run-dir "$OUTPUT_DIR" --config "$CONFIG")
if [ -n "$DATA_DIR" ]; then PREP_CMD+=(--data-dir "$DATA_DIR"); fi
if [ -n "$SMOKE_FLAG" ]; then PREP_CMD+=("$SMOKE_FLAG"); fi
"${PREP_CMD[@]}"

echo "== finetune =="
"$PYTHON_BIN" "$HERE/finetune_kokoro.py" \
  --run-dir "$OUTPUT_DIR" \
  --config "$CONFIG" \
  ${SMOKE_FLAG:+$SMOKE_FLAG}

echo "== extract voice embedding =="
EXTRACT_CMD=("$PYTHON_BIN" "$HERE/extract_voice_embedding.py" --out "$OUTPUT_DIR/voice.bin" --voice-name "$VOICE_NAME")
if [ "$SYNTHETIC_SMOKE" -eq 1 ]; then
  EXTRACT_CMD+=("--synthetic-smoke")
else
  EXTRACT_CMD+=("--clips-dir" "$OUTPUT_DIR/processed/wavs_norm")
fi
"${EXTRACT_CMD[@]}"

echo "== export onnx =="
EXPORT_CMD=("$PYTHON_BIN" "$HERE/export_to_onnx.py" \
    --out-dir "$OUTPUT_DIR" \
    --voice-name "$VOICE_NAME" \
    --voice-bin "$OUTPUT_DIR/voice.bin")
if [ "$SYNTHETIC_SMOKE" -eq 1 ]; then
  EXPORT_CMD+=("--synthetic-smoke")
elif [ -f "$OUTPUT_DIR/checkpoints/best.pt" ]; then
  EXPORT_CMD+=("--lora-checkpoint" "$OUTPUT_DIR/checkpoints/best.pt")
fi
"${EXPORT_CMD[@]}"

echo "== eval =="
EVAL_CMD=("$PYTHON_BIN" "$HERE/eval_kokoro.py" --run-dir "$OUTPUT_DIR" --config "$CONFIG" --voice-bin "$OUTPUT_DIR/voice.bin")
if [ "$SYNTHETIC_SMOKE" -eq 1 ]; then EVAL_CMD+=("--synthetic-smoke"); fi
if [ -n "$ALLOW_FAIL_FLAG" ]; then EVAL_CMD+=("$ALLOW_FAIL_FLAG"); fi
"${EVAL_CMD[@]}"

echo "== package release =="
PKG_CMD=("$PYTHON_BIN" "$HERE/package_voice_for_release.py" \
    --run-dir "$OUTPUT_DIR" \
    --release-dir "$RELEASE_DIR" \
    --voice-name "$VOICE_NAME")
if [ "$SYNTHETIC_SMOKE" -eq 1 ]; then
  PKG_CMD+=("--synthetic-smoke" "--allow-missing")
fi
"${PKG_CMD[@]}"

echo ""
echo "Done. Release bundle: $RELEASE_DIR/$VOICE_NAME"
echo "Final eval report:    $OUTPUT_DIR/eval.json"
echo "Manifest fragment:    $OUTPUT_DIR/manifest-fragment.json"
