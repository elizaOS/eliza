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
# Default image: `ghcr.io/ggml-org/llama.cpp:server-cuda` for normal GGUF.
# DFlash / TurboQuant flags require a compatible fork image; set
# LLAMA_SERVER_BIN or build an image from spiritbuun/buun-llama-cpp.
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
#   LLAMA_SERVER_PORT   — local server port (default: 8080).
#   MODEL_DIR           — where to cache the GGUF (default: /workspace/models).
#   LLAMA_SERVER_BIN    — binary to execute (default: llama-server).
#   DFLASH_DRAFTER_REPO — optional HF repo id for a DFlash drafter GGUF.
#   DFLASH_DRAFTER_FILE — optional drafter GGUF filename.
#   DFLASH_SPEC_TYPE    — default: dflash when a drafter is configured.
#   LLAMA_DRAFT_NGL     — drafter GPU layers (default: $LLAMA_NGL).
#   LLAMA_DRAFT_CONTEXT — drafter context size (default: 256).
#   LLAMA_DRAFT_MIN     — default: 1.
#   LLAMA_DRAFT_MAX     — default: 16.
#   LLAMA_CACHE_TYPE_K/V — optional KV cache type for TurboQuant-capable forks.
#   LLAMA_EXTRA_ARGS    — extra args appended verbatim.
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
LLAMA_SERVER_PORT="${LLAMA_SERVER_PORT:-8080}"
MODEL_DIR="${MODEL_DIR:-/workspace/models}"
PYWORKER_DIR="${PYWORKER_DIR:-/workspace/pyworker}"
LLAMA_LOG="${LLAMA_SERVER_LOG:-/var/log/llama-server.log}"
LLAMA_SERVER_BIN="${LLAMA_SERVER_BIN:-llama-server}"
DFLASH_DRAFTER_REPO="${DFLASH_DRAFTER_REPO:-}"
DFLASH_DRAFTER_FILE="${DFLASH_DRAFTER_FILE:-}"
DFLASH_SPEC_TYPE="${DFLASH_SPEC_TYPE:-dflash}"
LLAMA_DRAFT_NGL="${LLAMA_DRAFT_NGL:-$LLAMA_NGL}"
LLAMA_DRAFT_CONTEXT="${LLAMA_DRAFT_CONTEXT:-256}"
LLAMA_DRAFT_MIN="${LLAMA_DRAFT_MIN:-1}"
LLAMA_DRAFT_MAX="${LLAMA_DRAFT_MAX:-16}"
LLAMA_CACHE_TYPE_K="${LLAMA_CACHE_TYPE_K:-}"
LLAMA_CACHE_TYPE_V="${LLAMA_CACHE_TYPE_V:-}"
LLAMA_EXTRA_ARGS="${LLAMA_EXTRA_ARGS:-}"

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

DRAFTER_PATH=""
if [ -n "$DFLASH_DRAFTER_REPO" ] || [ -n "$DFLASH_DRAFTER_FILE" ]; then
  if [ -z "$DFLASH_DRAFTER_REPO" ] || [ -z "$DFLASH_DRAFTER_FILE" ]; then
    echo "[onstart] DFLASH_DRAFTER_REPO and DFLASH_DRAFTER_FILE must be set together" >&2
    exit 1
  fi
  DRAFTER_PATH="$MODEL_DIR/${DFLASH_DRAFTER_FILE}"
  if [ ! -f "$DRAFTER_PATH" ]; then
    echo "[onstart] downloading DFlash drafter $DFLASH_DRAFTER_REPO/$DFLASH_DRAFTER_FILE → $DRAFTER_PATH"
    python3 - <<EOF
from huggingface_hub import hf_hub_download
import os
hf_hub_download(
    repo_id="${DFLASH_DRAFTER_REPO}",
    filename="${DFLASH_DRAFTER_FILE}",
    local_dir="${MODEL_DIR}",
    token=os.environ.get("HUGGING_FACE_HUB_TOKEN"),
)
EOF
  fi
fi

# 4. Launch llama-server in the background. If it's already running (e.g.
#    container restarted with the binary still alive), skip.
LLAMA_ARGS=(
    --model "$MODEL_PATH"
    --alias "$MODEL_ALIAS"
    --host 127.0.0.1
    --port "$LLAMA_SERVER_PORT"
    --n-gpu-layers "$LLAMA_NGL"
    --ctx-size "$LLAMA_CONTEXT"
    --parallel "$LLAMA_PARALLEL"
    --metrics
    --log-disable
)
if [ -n "$DRAFTER_PATH" ]; then
  LLAMA_ARGS+=(
    -md "$DRAFTER_PATH"
    --spec-type "$DFLASH_SPEC_TYPE"
    --n-gpu-layers-draft "$LLAMA_DRAFT_NGL"
    --ctx-size-draft "$LLAMA_DRAFT_CONTEXT"
    --draft-min "$LLAMA_DRAFT_MIN"
    --draft-max "$LLAMA_DRAFT_MAX"
    --jinja
    --chat-template-kwargs '{"enable_thinking": false}'
  )
fi
if [ -n "$LLAMA_CACHE_TYPE_K" ]; then
  LLAMA_ARGS+=(--cache-type-k "$LLAMA_CACHE_TYPE_K")
fi
if [ -n "$LLAMA_CACHE_TYPE_V" ]; then
  LLAMA_ARGS+=(--cache-type-v "$LLAMA_CACHE_TYPE_V")
fi
if [ -n "$LLAMA_EXTRA_ARGS" ]; then
  # shellcheck disable=SC2206 # caller-provided word splitting is intentional.
  LLAMA_ARGS+=( $LLAMA_EXTRA_ARGS )
fi

if ! pgrep -f "$LLAMA_SERVER_BIN.*--port $LLAMA_SERVER_PORT" > /dev/null; then
  echo "[onstart] starting llama-server (bin=$LLAMA_SERVER_BIN, alias=$MODEL_ALIAS, ctx=$LLAMA_CONTEXT, parallel=$LLAMA_PARALLEL, dflash=$([ -n "$DRAFTER_PATH" ] && echo yes || echo no))"
  echo "[onstart] argv: $LLAMA_SERVER_BIN ${LLAMA_ARGS[*]}"
  nohup "$LLAMA_SERVER_BIN" "${LLAMA_ARGS[@]}" \
    > "$LLAMA_LOG" 2>&1 &
  echo "[onstart] llama-server pid: $!"
fi

# 5. Hand control to the PyWorker. It tails $LLAMA_LOG for the
#    "server is listening" line, registers handlers with the Vast
#    Serverless Engine, and proxies traffic.
echo "[onstart] launching PyWorker (model_alias=$MODEL_ALIAS, log=$LLAMA_LOG)"
exec env \
  MODEL_ALIAS="$MODEL_ALIAS" \
  LLAMA_SERVER_PORT="$LLAMA_SERVER_PORT" \
  LLAMA_SERVER_LOG="$LLAMA_LOG" \
  python3 worker.py
