#!/usr/bin/env bash
# Vast.ai template `on_start` script — vLLM flavor for the eliza-1 sizes.
#
# Sibling of the upstream llama-server `onstart.sh` shipped under
# `eliza/cloud/services/vast-pyworker/onstart.sh`. That script tails
# `llama-server` on port 8080; this one launches `vllm serve` on the port
# declared by the per-size manifest (8000 for the eliza-1 line) and hands
# control to the same upstream pyworker (`worker.py`) so the Vast Serverless
# autoscaler keeps its heartbeat contract.
#
# Pairs with the manifests in this directory:
#   eliza-1-2b.json  / eliza-1-9b.json / eliza-1-27b.json
# Each manifest declares the canonical `vllm_args` argv and a
# `vast_template_env` block (MODEL_REPO, MODEL_ALIAS, VLLM_PORT,
# VLLM_REGISTRY_KEY). This script reads BOTH from the manifest so the
# manifest stays single source of truth — do NOT duplicate vllm flags here.
#
# CONTRACT — required env (all four come from the manifest's
# `vast_template_env` block, exported into the Vast template):
#   MODEL_REPO          HF repo id (e.g. elizalabs/eliza-1-9b).
#   MODEL_ALIAS         display alias (e.g. vast/eliza-1-9b). Forwarded to
#                       worker.py so the pyworker reports the right name to
#                       the Vast Serverless Engine.
#   VLLM_PORT           port the manifest's vllm argv binds to. Must match
#                       the manifest's `port` field (the pyworker tails this
#                       port for /health).
#   VLLM_REGISTRY_KEY   training-side registry key (eliza-1-2b etc.) — used
#                       only for log lines and the registration hook.
#
# CONTRACT — optional env:
#   MILADY_VAST_MANIFEST    path to a per-size manifest JSON. Default:
#                           script-dir/eliza-1-${VLLM_REGISTRY_KEY##*-}.json
#                           (so VLLM_REGISTRY_KEY=eliza-1-9b -> eliza-1-9b.json).
#                           Override with an absolute path for custom manifests.
#   HUGGING_FACE_HUB_TOKEN  for gated repos. The published eliza-1 sibling
#                           repos are public; the bf16 base may be gated.
#   PYWORKER_REPO           git URL of cloud/. Default: elizaOS/cloud.
#   PYWORKER_REF            branch/tag/commit. Default: develop. Pin in prod.
#   MODEL_DIR               HF cache dir. Default /workspace/hf-cache.
#   PYWORKER_DIR            pyworker checkout dir. Default /workspace/pyworker.
#   VLLM_LOG                log file. Default /var/log/vllm-server.log.
#   VLLM_READY_TIMEOUT      hard timeout (s) waiting for `Application startup
#                           complete`. Default 600.
#
# OUTPUTS:
#   /var/log/vllm-server.log      vllm stdout/stderr (Vast template tails this)
#   /workspace/hf-cache/...       HF model snapshots (persistent)
#   $VLLM_PORT/health             vLLM built-in healthcheck (200 once ready)
#   exec → python3 worker.py      pyworker takes over for the heartbeat loop
#
# IDEMPOTENCY:
#   * Re-runs reuse the cached HF download (hf is content-aware).
#   * If `curl http://127.0.0.1:$VLLM_PORT/health` already returns 200 OR
#     a `vllm` process is bound to $VLLM_PORT, the relaunch is skipped and
#     we go straight to the pyworker exec.
#
# IMAGE:
#   Pin via the manifest's `image` field (default vllm/vllm-openai:v0.20.1).
#   That image already ships vllm + python3 + huggingface_hub + curl.
#   On non-vllm base images we `pip install vllm==<version>` as a fallback,
#   but the canonical path is the vllm/vllm-openai image so callers don't
#   eat a 4 GB pip install on cold start.
#
# UPSTREAM PYWORKER NOTES:
#   worker.py reads LLAMA_SERVER_PORT and LLAMA_SERVER_LOG (legacy env names
#   from the llama-server era). We export those pointing at vLLM's port and
#   log so the existing pyworker code Just Works without a fork. Revisit if
#   upstream renames them.

set -euo pipefail

# ---- 0. Resolve manifest + env ----------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

: "${MODEL_REPO:?MODEL_REPO is required (set via manifest vast_template_env)}"
: "${VLLM_PORT:?VLLM_PORT is required (set via manifest vast_template_env)}"
MODEL_ALIAS="${MODEL_ALIAS:-${MODEL_REPO##*/}}"
VLLM_REGISTRY_KEY="${VLLM_REGISTRY_KEY:-unknown}"

# Default manifest path: derive from the registry key suffix (eliza-1-9b -> 9b).
_default_manifest() {
  case "$VLLM_REGISTRY_KEY" in
    *-2b)  printf '%s/eliza-1-2b.json'  "$SCRIPT_DIR" ;;
    *-9b)  printf '%s/eliza-1-9b.json'  "$SCRIPT_DIR" ;;
    *-27b) printf '%s/eliza-1-27b.json' "$SCRIPT_DIR" ;;
    *)     printf '%s/eliza-1-2b.json'  "$SCRIPT_DIR" ;;
  esac
}
MILADY_VAST_MANIFEST="${MILADY_VAST_MANIFEST:-$(_default_manifest)}"
if [ ! -f "$MILADY_VAST_MANIFEST" ]; then
  echo "[onstart-vllm] manifest not found: $MILADY_VAST_MANIFEST" >&2
  exit 1
fi

PYWORKER_REPO="${PYWORKER_REPO:-https://github.com/elizaOS/cloud.git}"
PYWORKER_REF="${PYWORKER_REF:-develop}"
PYWORKER_DIR="${PYWORKER_DIR:-/workspace/pyworker}"
MODEL_DIR="${MODEL_DIR:-/workspace/hf-cache}"
VLLM_LOG="${VLLM_LOG:-/var/log/vllm-server.log}"
VLLM_READY_TIMEOUT="${VLLM_READY_TIMEOUT:-600}"

mkdir -p "$MODEL_DIR" "$PYWORKER_DIR" "$(dirname "$VLLM_LOG")"
export HF_HOME="$MODEL_DIR"

# ---- 1. Ensure vllm is on PATH ----------------------------------------------
# On vllm/vllm-openai images vllm is already installed. On a vanilla CUDA
# image we pin to the version the manifest declares (parsed from the
# `image` field, e.g. "vllm/vllm-openai:v0.20.1" → "0.20.1"). This is the
# only path-conditional behaviour in the script.
if ! command -v vllm >/dev/null 2>&1; then
  vllm_version="$(python3 - "$MILADY_VAST_MANIFEST" <<'PY'
import json, sys, re
m = json.load(open(sys.argv[1]))
image = m.get("image", "")
match = re.search(r":v?([0-9]+\.[0-9]+\.[0-9]+)$", image)
print(match.group(1) if match else "0.20.1")
PY
)"
  echo "[onstart-vllm] vllm not on PATH; installing vllm==$vllm_version"
  pip install --no-cache-dir "vllm==$vllm_version"
fi

# ---- 2. Pull the model ------------------------------------------------------
# Use the current HuggingFace CLI (`hf`) to stay aligned with train-side
# `hf download` calls in scripts/train_vast.sh. The CLI is content-aware,
# so re-runs on a warm instance hit the cache and exit fast.
if ! command -v hf >/dev/null 2>&1; then
  python3 -m pip install --no-cache-dir 'huggingface_hub[cli,hf_transfer]>=1.0.0' 'hf_xet>=1.0.0'
fi
export HF_HUB_ENABLE_HF_TRANSFER=1
echo "[onstart-vllm] ensuring $MODEL_REPO is cached under $MODEL_DIR"
hf download "$MODEL_REPO" \
  --cache-dir "$MODEL_DIR" \
  ${HUGGING_FACE_HUB_TOKEN:+--token "$HUGGING_FACE_HUB_TOKEN"} \
  >/dev/null

# ---- 3. Refresh pyworker repo ----------------------------------------------
if [ -d "$PYWORKER_DIR/.git" ]; then
  git -C "$PYWORKER_DIR" fetch --depth=1 origin "$PYWORKER_REF"
  git -C "$PYWORKER_DIR" checkout FETCH_HEAD
else
  git clone --depth=1 --branch "$PYWORKER_REF" "$PYWORKER_REPO" "$PYWORKER_DIR" \
    || git clone --depth=1 "$PYWORKER_REPO" "$PYWORKER_DIR"
fi
pip install --no-cache-dir -r "$PYWORKER_DIR/services/vast-pyworker/requirements.txt"

# ---- 4. Build the vllm argv from the manifest -------------------------------
# Single source of truth: the manifest's `vllm_args` array. We strip the
# leading ["vllm", "serve", ...] tokens because we exec vllm directly with
# the rest as its argv.
mapfile -t VLLM_ARGS < <(python3 - "$MILADY_VAST_MANIFEST" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))
args = list(m.get("vllm_args", []))
# Drop the leading executable+subcommand tokens the manifest carries for
# documentation. Whatever shape they take, normalise to `serve <repo> ...`.
while args and args[0] in ("vllm", "python", "python3", "-m"):
    args.pop(0)
print("\n".join(args))
PY
)
# Force --host 127.0.0.1 (pyworker proxies the public port) if the manifest
# didn't already pin one.
if ! printf '%s\n' "${VLLM_ARGS[@]}" | grep -q -- '--host'; then
  VLLM_ARGS+=(--host 127.0.0.1)
fi

# ---- 5. Launch vllm (idempotent) -------------------------------------------
already_up=0
if curl -fsS "http://127.0.0.1:${VLLM_PORT}/health" >/dev/null 2>&1; then
  echo "[onstart-vllm] /health already 200 on :$VLLM_PORT — skipping launch"
  already_up=1
elif pgrep -f "vllm.*--port[ =]${VLLM_PORT}" >/dev/null 2>&1; then
  echo "[onstart-vllm] vllm process already bound to :$VLLM_PORT — skipping launch"
  already_up=1
fi

if [ "$already_up" = "0" ]; then
  echo "[onstart-vllm] launching vllm (model=$MODEL_REPO alias=$MODEL_ALIAS port=$VLLM_PORT key=$VLLM_REGISTRY_KEY)"
  echo "[onstart-vllm] argv: vllm ${VLLM_ARGS[*]}"
  : > "$VLLM_LOG"
  nohup vllm "${VLLM_ARGS[@]}" >"$VLLM_LOG" 2>&1 &
  vllm_pid=$!
  echo "[onstart-vllm] vllm pid: $vllm_pid"

  # Tail the log for the upstream-stable readiness signal.
  echo "[onstart-vllm] waiting for 'Application startup complete' (timeout ${VLLM_READY_TIMEOUT}s)"
  deadline=$(( $(date +%s) + VLLM_READY_TIMEOUT ))
  while :; do
    if grep -Fq "Application startup complete" "$VLLM_LOG" 2>/dev/null; then
      echo "[onstart-vllm] vllm reports startup complete"
      break
    fi
    if ! kill -0 "$vllm_pid" 2>/dev/null; then
      echo "[onstart-vllm] vllm process exited before becoming ready — see $VLLM_LOG" >&2
      tail -n 50 "$VLLM_LOG" >&2 || true
      exit 1
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "[onstart-vllm] timeout waiting for vllm readiness — see $VLLM_LOG" >&2
      tail -n 50 "$VLLM_LOG" >&2 || true
      exit 1
    fi
    sleep 2
  done

  # /health should respond 200 within 60s of "Application startup complete".
  health_deadline=$(( $(date +%s) + 60 ))
  until curl -fsS "http://127.0.0.1:${VLLM_PORT}/health" >/dev/null 2>&1; do
    if [ "$(date +%s)" -ge "$health_deadline" ]; then
      echo "[onstart-vllm] /health did not return 200 within 60s of startup-complete" >&2
      tail -n 50 "$VLLM_LOG" >&2 || true
      exit 1
    fi
    sleep 1
  done
  echo "[onstart-vllm] /health 200 on :$VLLM_PORT"
fi

# ---- 6. Hand control to pyworker -------------------------------------------
# worker.py reads the LLAMA_SERVER_* env vars (legacy names retained when
# the upstream pyworker grew vLLM support). MODEL_ALIAS is what the
# pyworker reports back to the Vast Serverless Engine.
echo "[onstart-vllm] launching pyworker (alias=$MODEL_ALIAS, log=$VLLM_LOG, port=$VLLM_PORT)"
cd "$PYWORKER_DIR/services/vast-pyworker"
exec env \
  MODEL_ALIAS="$MODEL_ALIAS" \
  LLAMA_SERVER_PORT="$VLLM_PORT" \
  LLAMA_SERVER_LOG="$VLLM_LOG" \
  python3 worker.py
