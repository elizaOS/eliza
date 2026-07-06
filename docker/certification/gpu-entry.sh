#!/usr/bin/env bash
# Entrypoint for the single GPU-owning gpu-vision container: both resident
# llama-server instances (Unlimited-OCR + Qwen3-VL) run here, in one container,
# so lanes share the GPU *service* over HTTP rather than the device itself.
# Either server dying takes the container down (wait -n under set -e) so
# compose surfaces the failure instead of half the queue silently stalling.
# Model paths/ports arrive as environment baked by generate-compose-lanes.mjs
# from scripts/gpu-vision (models.lock.json pins the exact blobs).
set -euo pipefail

: "${OCR_MODEL:?OCR_MODEL is required}"
: "${OCR_MMPROJ:?OCR_MMPROJ is required}"
: "${VLM_MODEL:?VLM_MODEL is required}"
: "${VLM_MMPROJ:?VLM_MMPROJ is required}"

PARALLEL="${LLAMA_PARALLEL:-4}"
CONTEXT="${LLAMA_CONTEXT:-8192}"

for blob in "$OCR_MODEL" "$OCR_MMPROJ" "$VLM_MODEL" "$VLM_MMPROJ"; do
  if [ ! -f "$blob" ]; then
    echo "[gpu-entry] missing model blob: $blob — populate the models mount with scripts/gpu-vision/setup.mjs --with-vlm" >&2
    exit 1
  fi
done

echo "[gpu-entry] launching Unlimited-OCR llama-server on :${OCR_PORT:-8090} (parallel=${PARALLEL}, ctx=${CONTEXT})"
llama-server -m "$OCR_MODEL" --mmproj "$OCR_MMPROJ" -c "$CONTEXT" \
  --parallel "$PARALLEL" --host 0.0.0.0 --port "${OCR_PORT:-8090}" &

echo "[gpu-entry] launching Qwen3-VL llama-server on :${VLM_PORT:-8091} (parallel=${PARALLEL}, ctx=${CONTEXT})"
llama-server -m "$VLM_MODEL" --mmproj "$VLM_MMPROJ" -c "$CONTEXT" \
  --parallel "$PARALLEL" --host 0.0.0.0 --port "${VLM_PORT:-8091}" &

# First server to exit ends the container; a healthy stack never reaches here.
wait -n
echo "[gpu-entry] a llama-server exited — tearing the gpu-vision service down" >&2
exit 1
