#!/usr/bin/env bash
# Vast.ai template `on_start` script.
#
# Pulls the GGUF once into a persistent volume, launches `llama-server`, and
# then starts the Python PyWorker that proxies traffic for the Vast Serverless
# autoscaler. The container image is expected to bundle:
#   - llama.cpp's `llama-server` on PATH (build with CUDA support)
#   - python3 + pip
#   - git
#
# Recommended image: `ghcr.io/ggml-org/llama.cpp:server-cuda` (CUDA build of
# the official llama.cpp server). That image already has llama-server,
# CUDA runtime, and python3.
#
# Required template env vars (set in the Vast template definition):
#   PYWORKER_REPO       — git URL of cloud/ (e.g. https://github.com/elizaOS/cloud.git)
#   PYWORKER_REF        — branch / tag / commit (use a pinned commit in prod)
#   MODEL_REPO          — HuggingFace repo id of the GGUF (default: DavidAU…)
#   MODEL_FILE          — GGUF file inside the repo (default: Q6_K)
#   MODEL_ALIAS         — llama-server `--alias` (default: vast/qwen3.6-27b-neo-code)
#
# Optional:
#   HUGGING_FACE_HUB_TOKEN — for gated/private repos. The DavidAU Q6_K we
#                           default to is public Apache-2.0, so this is
#                           usually unnecessary.
#   LLAMA_CONTEXT       — context window (default: 32768; max for Qwen3.6 is 262144).
#   LLAMA_PARALLEL      — concurrent decode slots (default: 2 on RTX 5090; 4 on 48 GB cards).
#   LLAMA_NGL           — layers offloaded to GPU (default: 99 = all).
#   MODEL_DIR           — where to cache the GGUF (default: /workspace/models).
#
# This script is idempotent: re-runs reuse the cached GGUF and only relaunch
# `llama-server` if it isn't already up.

set -euo pipefail

PYWORKER_REPO="${PYWORKER_REPO:-https://github.com/elizaOS/cloud.git}"
PYWORKER_REF="${PYWORKER_REF:-develop}"
MODEL_REPO="${MODEL_REPO:-DavidAU/Qwen3.6-27B-Heretic-Uncensored-FINETUNE-NEO-CODE-Di-IMatrix-MAX-GGUF}"
MODEL_FILE="${MODEL_FILE:-Qwen3.6-27B-NEO-CODE-HERE-2T-OT-Q6_K.gguf}"
MODEL_ALIAS="${MODEL_ALIAS:-vast/qwen3.6-27b-neo-code}"
LLAMA_CONTEXT="${LLAMA_CONTEXT:-32768}"
LLAMA_PARALLEL="${LLAMA_PARALLEL:-2}"
LLAMA_NGL="${LLAMA_NGL:-99}"
MODEL_DIR="${MODEL_DIR:-/workspace/models}"
PYWORKER_DIR="${PYWORKER_DIR:-/workspace/pyworker}"
LLAMA_LOG="${LLAMA_SERVER_LOG:-/var/log/llama-server.log}"

mkdir -p "$MODEL_DIR" "$PYWORKER_DIR" "$(dirname "$LLAMA_LOG")"

# 1. Clone or refresh the PyWorker repo.
if [ -d "$PYWORKER_DIR/.git" ]; then
  git -C "$PYWORKER_DIR" fetch --depth=1 origin "$PYWORKER_REF"
  git -C "$PYWORKER_DIR" checkout FETCH_HEAD
else
  git clone --depth=1 --branch "$PYWORKER_REF" "$PYWORKER_REPO" "$PYWORKER_DIR" \
    || git clone --depth=1 "$PYWORKER_REPO" "$PYWORKER_DIR"
fi

cd "$PYWORKER_DIR/services/vast-pyworker"

# 2. Install Python deps for the PyWorker (NOT for llama-server — that's
#    the bundled binary in the image).
pip install --no-cache-dir -r requirements.txt

# 3. Download the GGUF into the persistent volume if missing.
MODEL_PATH="$MODEL_DIR/${MODEL_FILE}"
if [ ! -f "$MODEL_PATH" ]; then
  echo "[onstart] downloading $MODEL_REPO/$MODEL_FILE → $MODEL_PATH"
  python3 - <<EOF
from huggingface_hub import hf_hub_download
import os
hf_hub_download(
    repo_id="${MODEL_REPO}",
    filename="${MODEL_FILE}",
    local_dir="${MODEL_DIR}",
    token=os.environ.get("HUGGING_FACE_HUB_TOKEN"),
)
EOF
fi

# 4. Launch llama-server in the background. If it's already running (e.g.
#    container restarted with the binary still alive), skip.
if ! pgrep -f "llama-server.*--port 8080" > /dev/null; then
  echo "[onstart] starting llama-server (alias=$MODEL_ALIAS, ctx=$LLAMA_CONTEXT, parallel=$LLAMA_PARALLEL)"
  nohup llama-server \
    --model "$MODEL_PATH" \
    --alias "$MODEL_ALIAS" \
    --host 127.0.0.1 \
    --port 8080 \
    --n-gpu-layers "$LLAMA_NGL" \
    --ctx-size "$LLAMA_CONTEXT" \
    --parallel "$LLAMA_PARALLEL" \
    --metrics \
    --log-disable \
    > "$LLAMA_LOG" 2>&1 &
  echo "[onstart] llama-server pid: $!"
fi

# 5. Hand control to the PyWorker. It tails $LLAMA_LOG for the
#    "server is listening" line, registers handlers with the Vast
#    Serverless Engine, and proxies traffic.
echo "[onstart] launching PyWorker (model_alias=$MODEL_ALIAS, log=$LLAMA_LOG)"
exec env \
  MODEL_ALIAS="$MODEL_ALIAS" \
  LLAMA_SERVER_PORT=8080 \
  LLAMA_SERVER_LOG="$LLAMA_LOG" \
  python3 worker.py
