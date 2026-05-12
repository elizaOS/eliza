#!/usr/bin/env bash
# Vast.ai template `on_start` script — vLLM flavor.
#
# Sibling of `onstart.sh` (which serves GGUF via llama-server). This script
# pulls a HuggingFace safetensors model and serves it through `vllm serve`
# on the OpenAI-compatible endpoint at $PORT. Container image is expected
# to bundle vLLM (default: `vllm/vllm-openai:v0.20.1`).
#
# This file is the runtime counterpart of the per-size manifests in
# `training/cloud/vast-pyworker/eliza-1-{2b,9b,27b}.json`. It replicates
# the `vllm_args` shape from those manifests + scripts/inference/serve_vllm.py
# without importing serve_vllm.py (which lives in the training repo and
# isn't packaged in the cloud submodule).
#
# Required template env vars:
#   MODEL_REPO              — HuggingFace repo id (e.g. elizaos/eliza-1-27b-fp8).
#                             OR set MILADY_VAST_MANIFEST=eliza-1-{2b,9b,27b}.json
#                             and the script extracts MODEL_REPO + all flags
#                             from the manifest.
#
# Optional (defaults match training/cloud/vast-pyworker/eliza-1-27b.json):
#   MILADY_VAST_MANIFEST    — path to a per-size manifest JSON. When set, the
#                             manifest fills any unset env var below. Caller
#                             env always wins. Default: eliza-1-2b.json
#                             (resolved against the script's manifests/ subdir
#                             or /workspace/manifests/).
#   PORT                    — default 8000 (matches manifest health-check URLs).
#   SERVED_MODEL_NAME       — vLLM `--served-model-name`. Default: $MODEL_ALIAS or
#                             the basename of $MODEL_REPO.
#   MODEL_ALIAS             — display alias passed through to PyWorker (informational).
#   TENSOR_PARALLEL_SIZE    — default 1 (set 2 for h200-2x / blackwell6000-2x).
#   EXPERT_PARALLEL_SIZE    — default 1; set 2 for 27B EP=2.
#   MAX_MODEL_LEN           — default 147456 (matches the eliza-1 registry).
#   GPU_MEMORY_UTILIZATION  — default 0.90.
#   WEIGHT_QUANT            — vLLM `--quantization` flag value (fp8 / awq_marlin
#                             / "" to skip). Empty = bf16 / native.
#   KV_CACHE_DTYPE          — vLLM `--kv-cache-dtype` (fp8_e4m3 / auto /
#                             turboquant_k8v4 / turboquant_4bit_nc). Empty =
#                             vLLM default.
#   VLLM_ENABLE_TURBOQUANT  — set 1/true to derive KV_CACHE_DTYPE from
#                             VLLM_TURBOQUANT_PRESET when KV_CACHE_DTYPE is
#                             empty or auto.
#   VLLM_TURBOQUANT_PRESET  — quality/default => turboquant_k8v4; 4bit =>
#                             turboquant_4bit_nc. More aggressive presets must
#                             be requested by their exact vLLM dtype.
#   DFLASH_MODEL            — optional HF drafter repo/path for vLLM DFlash.
#                             Requires a vLLM build that supports method=dflash.
#   SPECULATIVE_CONFIG_JSON — raw vLLM speculative config JSON. Overrides
#                             DFLASH_MODEL when set.
#   SPECULATIVE_TOKENS      — default 15 for DFlash.
#   DRAFT_TENSOR_PARALLEL_SIZE — optional draft TP for speculative decoding.
#   DRAFT_MAX_MODEL_LEN     — optional draft max context for speculative decoding.
#   ADDITIONAL_CONFIG_JSON  — raw vLLM `--additional-config` JSON.
#   VLLM_METAL_ADDITIONAL_CONFIG_JSON — additional-config JSON used when
#                             running under vllm-metal / Apple Silicon.
#   VLLM_EXPERIMENTAL_QJL   — explicit experimental QJL opt-in. Requires
#                             VLLM_QJL_BENCHMARK_GATE=passed and appends
#                             QJL_ADDITIONAL_CONFIG_JSON to additional-config.
#   TOOL_PARSER             — default eliza1.
#   REASONING_PARSER        — default eliza1.
#   COMPILATION_CONFIG_JSON — JSON blob for `--compilation-config`. Empty = skip.
#   EXTRA_VLLM_ARGS         — extra args appended verbatim before --port.
#   HUGGING_FACE_HUB_TOKEN  — for gated repos.
#   VLLM_LOG                — log file path. Default /var/log/vllm.log.
#   PYWORKER_REPO / _REF    — same as onstart.sh; the PyWorker still proxies.
#   VLLM_STATS_PATH         — where the periodic stats logger writes
#                             tokens/s + KV bytes/token. Default
#                             ~/.cache/vllm-stats.jsonl (consumed by sister
#                             agents that grep this file).
#   VLLM_STATS_INTERVAL_S   — stats sampling interval. Default 60.
#
# This script is idempotent: re-runs reuse the cached HF download and only
# relaunch vllm if it isn't already up on $PORT.

set -euo pipefail

# 0. Manifest resolution (optional). When MILADY_VAST_MANIFEST points at a
# per-size manifest JSON we slurp its canonical fields into env vars (only
# those not already set by the caller). This is the load-bearing change that
# lets a single template env var (MILADY_VAST_MANIFEST=eliza-1-9b.json)
# drive the whole vllm flag set.
MILADY_VAST_MANIFEST="${MILADY_VAST_MANIFEST:-eliza-1-2b.json}"
_resolve_manifest() {
  local m="$1"
  if [ -n "${MILADY_VAST_MANIFEST_JSON:-}" ]; then
    local embedded="/tmp/milady-vast-manifest.json"
    printf '%s' "$MILADY_VAST_MANIFEST_JSON" > "$embedded"
    echo "$embedded"
    return 0
  fi
  if [ "${m:0:1}" = "/" ] && [ -f "$m" ]; then echo "$m"; return 0; fi
  for d in \
    "$(dirname "${BASH_SOURCE[0]}")/manifests" \
    "$(dirname "${BASH_SOURCE[0]}")" \
    "/workspace/manifests" \
    "/workspace" \
    "$(dirname "${BASH_SOURCE[0]}")/../../../training/cloud/vast-pyworker"; do
    if [ -f "$d/$m" ]; then echo "$d/$m"; return 0; fi
  done
  return 1
}
if MANIFEST_PATH="$(_resolve_manifest "$MILADY_VAST_MANIFEST")"; then
  echo "[onstart-vllm] loading manifest $MANIFEST_PATH"
  eval "$(python3 - "$MANIFEST_PATH" <<'PY'
import json, os, sys, shlex
m = json.load(open(sys.argv[1]))
mapping = {
    "MODEL_REPO": m.get("model") or m.get("model_repo"),
    "SERVED_MODEL_NAME": m.get("served_model_name"),
    "MODEL_ALIAS": m.get("model_alias"),
    "TENSOR_PARALLEL_SIZE": m.get("tensor_parallel_size"),
    "EXPERT_PARALLEL_SIZE": m.get("expert_parallel_size"),
    "MAX_MODEL_LEN": m.get("max_model_len"),
    "GPU_MEMORY_UTILIZATION": m.get("gpu_memory_utilization"),
    "WEIGHT_QUANT": m.get("weight_quantization"),
    "KV_CACHE_DTYPE": m.get("kv_cache_dtype"),
    "VLLM_TURBOQUANT_PRESET": m.get("turboquant_preset"),
    "VLLM_ENABLE_TURBOQUANT": m.get("enable_turboquant"),
    "DFLASH_MODEL": m.get("dflash_model"),
    "SPECULATIVE_CONFIG_JSON": m.get("speculative_config"),
    "SPECULATIVE_TOKENS": m.get("speculative_tokens"),
    "DRAFT_TENSOR_PARALLEL_SIZE": m.get("draft_tensor_parallel_size"),
    "DRAFT_MAX_MODEL_LEN": m.get("draft_max_model_len"),
    "ADDITIONAL_CONFIG_JSON": m.get("additional_config"),
    "COMPILATION_CONFIG_JSON": m.get("compilation_config"),
    "TOOL_PARSER": m.get("tool_parser"),
    "REASONING_PARSER": m.get("reasoning_parser"),
    "PORT": m.get("port"),
}
args = list(m.get("vllm_args") or [])
for i, token in enumerate(args):
    if i + 1 >= len(args):
        continue
    if token == "--compilation-config" and not mapping.get("COMPILATION_CONFIG_JSON"):
        mapping["COMPILATION_CONFIG_JSON"] = args[i + 1]
    if token == "--additional-config" and not mapping.get("ADDITIONAL_CONFIG_JSON"):
        mapping["ADDITIONAL_CONFIG_JSON"] = args[i + 1]
if isinstance(mapping.get("SPECULATIVE_CONFIG_JSON"), dict):
    mapping["SPECULATIVE_CONFIG_JSON"] = json.dumps(mapping["SPECULATIVE_CONFIG_JSON"], separators=(",", ":"))
if isinstance(mapping.get("ADDITIONAL_CONFIG_JSON"), dict):
    mapping["ADDITIONAL_CONFIG_JSON"] = json.dumps(mapping["ADDITIONAL_CONFIG_JSON"], separators=(",", ":"))
if isinstance(mapping.get("COMPILATION_CONFIG_JSON"), dict):
    mapping["COMPILATION_CONFIG_JSON"] = json.dumps(mapping["COMPILATION_CONFIG_JSON"], separators=(",", ":"))
for k, v in mapping.items():
    if v is None or v == "":
        continue
    if os.environ.get(k):
        continue
    print(f"export {k}={shlex.quote(str(v))}")
PY
)"
else
  echo "[onstart-vllm] no manifest at $MILADY_VAST_MANIFEST (proceeding with raw env)"
fi

PORT="${PORT:-8000}"
MODEL_REPO="${MODEL_REPO:?MODEL_REPO is required (HF repo id) — set via MILADY_VAST_MANIFEST or MODEL_REPO}"
SERVED_MODEL_NAME_DEFAULT="${MODEL_REPO##*/}"
SERVED_MODEL_NAME="${SERVED_MODEL_NAME:-${MODEL_ALIAS:-$SERVED_MODEL_NAME_DEFAULT}}"
TENSOR_PARALLEL_SIZE="${TENSOR_PARALLEL_SIZE:-1}"
EXPERT_PARALLEL_SIZE="${EXPERT_PARALLEL_SIZE:-1}"
MAX_MODEL_LEN="${MAX_MODEL_LEN:-147456}"
GPU_MEMORY_UTILIZATION="${GPU_MEMORY_UTILIZATION:-0.90}"
WEIGHT_QUANT="${WEIGHT_QUANT:-}"
KV_CACHE_DTYPE="${KV_CACHE_DTYPE:-}"
VLLM_ENABLE_TURBOQUANT="${VLLM_ENABLE_TURBOQUANT:-0}"
VLLM_TURBOQUANT_PRESET="${VLLM_TURBOQUANT_PRESET:-quality}"
TOOL_PARSER="${TOOL_PARSER:-eliza1}"
REASONING_PARSER="${REASONING_PARSER:-eliza1}"
COMPILATION_CONFIG_JSON="${COMPILATION_CONFIG_JSON:-}"
ADDITIONAL_CONFIG_JSON="${ADDITIONAL_CONFIG_JSON:-}"
VLLM_METAL_ADDITIONAL_CONFIG_JSON="${VLLM_METAL_ADDITIONAL_CONFIG_JSON:-}"
DFLASH_MODEL="${DFLASH_MODEL:-}"
SPECULATIVE_CONFIG_JSON="${SPECULATIVE_CONFIG_JSON:-}"
SPECULATIVE_TOKENS="${SPECULATIVE_TOKENS:-15}"
DRAFT_TENSOR_PARALLEL_SIZE="${DRAFT_TENSOR_PARALLEL_SIZE:-}"
DRAFT_MAX_MODEL_LEN="${DRAFT_MAX_MODEL_LEN:-}"
VLLM_EXPERIMENTAL_QJL="${VLLM_EXPERIMENTAL_QJL:-0}"
VLLM_QJL_BENCHMARK_GATE="${VLLM_QJL_BENCHMARK_GATE:-}"
QJL_ADDITIONAL_CONFIG_JSON="${QJL_ADDITIONAL_CONFIG_JSON:-{\"qjl\":true}}"
EXTRA_VLLM_ARGS="${EXTRA_VLLM_ARGS:-}"
VLLM_LOG="${VLLM_LOG:-/var/log/vllm.log}"
PYWORKER_REPO="${PYWORKER_REPO:-https://github.com/elizaOS/cloud.git}"
PYWORKER_REF="${PYWORKER_REF:-develop}"
PYWORKER_DIR="${PYWORKER_DIR:-/workspace/pyworker}"
HF_HOME="${HF_HOME:-/workspace/hf-cache}"
VLLM_STATS_PATH="${VLLM_STATS_PATH:-$HOME/.cache/vllm-stats.jsonl}"
VLLM_STATS_INTERVAL_S="${VLLM_STATS_INTERVAL_S:-60}"

mkdir -p "$HF_HOME" "$PYWORKER_DIR" "$(dirname "$VLLM_LOG")" "$(dirname "$VLLM_STATS_PATH")"
export HF_HOME

truthy() {
  case "${1,,}" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

resolve_turboquant_dtype() {
  case "${1,,}" in
    ""|quality|default|k8v4|turboquant_k8v4) printf '%s\n' "turboquant_k8v4" ;;
    4bit|4bit_nc|turboquant_4bit|turboquant_4bit_nc) printf '%s\n' "turboquant_4bit_nc" ;;
    k3v4|k3v4_nc|turboquant_k3v4_nc) printf '%s\n' "turboquant_k3v4_nc" ;;
    3bit|3bit_nc|turboquant_3bit_nc) printf '%s\n' "turboquant_3bit_nc" ;;
    turboquant_*) printf '%s\n' "$1" ;;
    *)
      echo "[onstart-vllm] unknown VLLM_TURBOQUANT_PRESET=$1" >&2
      return 1
      ;;
  esac
}

merge_json_objects() {
  python3 - "$@" <<'PY'
import json, sys
merged = {}
for raw in sys.argv[1:]:
    if not raw:
        continue
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise SystemExit("additional-config fragments must be JSON objects")
    merged.update(value)
print(json.dumps(merged, separators=(",", ":")))
PY
}

# 1. Refresh PyWorker (proxies traffic to vLLM and reports health to Vast).
if [ -d "$PYWORKER_DIR/.git" ]; then
  git -C "$PYWORKER_DIR" fetch --depth=1 origin "$PYWORKER_REF"
  git -C "$PYWORKER_DIR" checkout FETCH_HEAD
else
  git clone --depth=1 --branch "$PYWORKER_REF" "$PYWORKER_REPO" "$PYWORKER_DIR" \
    || git clone --depth=1 "$PYWORKER_REPO" "$PYWORKER_DIR"
fi
cd "$PYWORKER_DIR/services/vast-pyworker"
pip install --no-cache-dir -r requirements.txt

# 2. Optional HF login (gated repos like base eliza-1 need this).
if [ -n "${HUGGING_FACE_HUB_TOKEN:-}" ]; then
  python3 -c "from huggingface_hub import login; login(token='${HUGGING_FACE_HUB_TOKEN}', add_to_git_credential=False)"
fi

# 3. Build the vllm serve argv. Mirror training/cloud/vast-pyworker/*.json
# — same flag set, same defaults — without importing serve_vllm.py.
VLLM_ARGS=(
  serve "$MODEL_REPO"
  --tensor-parallel-size "$TENSOR_PARALLEL_SIZE"
  --max-model-len "$MAX_MODEL_LEN"
  --gpu-memory-utilization "$GPU_MEMORY_UTILIZATION"
  --dtype bfloat16
)
# Manifest-driven expert-parallel for the 27B EP=2 path. vLLM only honors
# --expert-parallel-size when the model has MoE layers; for the dense
# eliza-1 sizes setting EP=1 is a no-op so we always emit it explicitly.
if [ "$EXPERT_PARALLEL_SIZE" -gt 1 ] 2>/dev/null; then
  VLLM_ARGS+=(--expert-parallel-size "$EXPERT_PARALLEL_SIZE")
fi
if [ -n "$WEIGHT_QUANT" ] && [ "$WEIGHT_QUANT" != "auto" ] && [ "$WEIGHT_QUANT" != "none" ]; then
  VLLM_ARGS+=(--quantization "$WEIGHT_QUANT")
fi
if truthy "$VLLM_ENABLE_TURBOQUANT"; then
  resolved_tq_dtype="$(resolve_turboquant_dtype "$VLLM_TURBOQUANT_PRESET")"
  if [ -z "$KV_CACHE_DTYPE" ] || [ "$KV_CACHE_DTYPE" = "auto" ]; then
    KV_CACHE_DTYPE="$resolved_tq_dtype"
  elif [ "$KV_CACHE_DTYPE" != "$resolved_tq_dtype" ]; then
    echo "[onstart-vllm] KV_CACHE_DTYPE=$KV_CACHE_DTYPE overrides VLLM_TURBOQUANT_PRESET=$VLLM_TURBOQUANT_PRESET ($resolved_tq_dtype)" >&2
  fi
fi
if [ -n "$KV_CACHE_DTYPE" ] && [ "$KV_CACHE_DTYPE" != "auto" ]; then
  VLLM_ARGS+=(--kv-cache-dtype "$KV_CACHE_DTYPE")
fi
VLLM_ARGS+=(
  --enable-prefix-caching
  --block-size 16
  --enable-chunked-prefill
  --max-num-batched-tokens 8192
  --long-prefill-token-threshold 2048
  --reasoning-parser "$REASONING_PARSER"
  --enable-auto-tool-choice
  --tool-call-parser "$TOOL_PARSER"
)
if [ -n "$COMPILATION_CONFIG_JSON" ]; then
  VLLM_ARGS+=(--compilation-config "$COMPILATION_CONFIG_JSON")
fi
if [ "$(uname -s 2>/dev/null || true)" = "Darwin" ] || [ "${VLLM_DEVICE:-}" = "metal" ] || [ "${VLLM_PLATFORM:-}" = "metal" ]; then
  if truthy "${VLLM_ENABLE_METAL_TURBOQUANT:-0}" && [ -z "$VLLM_METAL_ADDITIONAL_CONFIG_JSON" ]; then
    case "${VLLM_TURBOQUANT_PRESET,,}" in
      4bit|4bit_nc|turboquant_4bit|turboquant_4bit_nc)
        VLLM_METAL_ADDITIONAL_CONFIG_JSON='{"turboquant":true,"k_quant":"q4_0","v_quant":"q3_0"}'
        ;;
      *)
        VLLM_METAL_ADDITIONAL_CONFIG_JSON='{"turboquant":true,"k_quant":"q8_0","v_quant":"q3_0"}'
        ;;
    esac
  fi
  if [ -n "$VLLM_METAL_ADDITIONAL_CONFIG_JSON" ]; then
    export VLLM_METAL_USE_PAGED_ATTENTION="${VLLM_METAL_USE_PAGED_ATTENTION:-1}"
    ADDITIONAL_CONFIG_JSON="$(merge_json_objects "$ADDITIONAL_CONFIG_JSON" "$VLLM_METAL_ADDITIONAL_CONFIG_JSON")"
  fi
fi
if truthy "$VLLM_EXPERIMENTAL_QJL"; then
  if [ "$VLLM_QJL_BENCHMARK_GATE" != "passed" ]; then
    echo "[onstart-vllm] refusing experimental QJL: set VLLM_QJL_BENCHMARK_GATE=passed after a quality benchmark to enable" >&2
    exit 1
  fi
  echo "[onstart-vllm] enabling experimental QJL additional-config; this is benchmark-gated and not a default" >&2
  ADDITIONAL_CONFIG_JSON="$(merge_json_objects "$ADDITIONAL_CONFIG_JSON" "$QJL_ADDITIONAL_CONFIG_JSON")"
fi
if [ -n "$ADDITIONAL_CONFIG_JSON" ]; then
  VLLM_ARGS+=(--additional-config "$ADDITIONAL_CONFIG_JSON")
fi
if [ -z "$SPECULATIVE_CONFIG_JSON" ] && [ -n "$DFLASH_MODEL" ]; then
  if [ "${MILADY_VLLM_DFLASH:-}" != "1" ] && [ "${MILADY_VLLM_DFLASH:-}" != "true" ]; then
    echo "[onstart-vllm] DFLASH_MODEL set without MILADY_VLLM_DFLASH=1; continuing, but stock vLLM may reject method=dflash" >&2
  fi
  SPECULATIVE_CONFIG_JSON="$(python3 - <<PY
import json, os
config = {
    "method": "dflash",
    "model": os.environ["DFLASH_MODEL"],
    "num_speculative_tokens": int(os.environ.get("SPECULATIVE_TOKENS", "15")),
}
if os.environ.get("DRAFT_TENSOR_PARALLEL_SIZE"):
    config["draft_tensor_parallel_size"] = int(os.environ["DRAFT_TENSOR_PARALLEL_SIZE"])
if os.environ.get("DRAFT_MAX_MODEL_LEN"):
    config["max_model_len"] = int(os.environ["DRAFT_MAX_MODEL_LEN"])
print(json.dumps(config, separators=(",", ":")))
PY
)"
fi
if [ -n "$SPECULATIVE_CONFIG_JSON" ]; then
  VLLM_ARGS+=(--speculative-config "$SPECULATIVE_CONFIG_JSON")
fi
if [ -n "$EXTRA_VLLM_ARGS" ]; then
  # shellcheck disable=SC2206 # caller-provided word splitting is intentional
  VLLM_ARGS+=( $EXTRA_VLLM_ARGS )
fi
VLLM_ARGS+=(
  --port "$PORT"
  --served-model-name "$SERVED_MODEL_NAME"
  --host 127.0.0.1
)

# 4. Launch vLLM. If the OpenAI server is already up on $PORT, skip.
if ! pgrep -f "vllm.*--port[ =]$PORT" > /dev/null && \
   ! curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  echo "[onstart-vllm] starting vLLM (model=$MODEL_REPO served-name=$SERVED_MODEL_NAME tp=$TENSOR_PARALLEL_SIZE port=$PORT)"
  echo "[onstart-vllm] argv: vllm ${VLLM_ARGS[*]}"
  nohup vllm "${VLLM_ARGS[@]}" > "$VLLM_LOG" 2>&1 &
  echo "[onstart-vllm] vllm pid: $!"
fi

# === stats logger (sister-agent contract) ===
# Writes a minimal {ts, tokens_per_sec, kv_bytes_per_token, gpu_mem_used}
# snapshot every $VLLM_STATS_INTERVAL_S seconds to $VLLM_STATS_PATH. The
# heartbeat block below produces the rich observability stream; this thin
# logger exists because a sister agent's pipeline grep's vllm-stats.jsonl.
echo "[onstart-vllm] starting vllm-stats logger (out=$VLLM_STATS_PATH interval=${VLLM_STATS_INTERVAL_S}s)"
nohup bash -c '
  : > "'"$VLLM_STATS_PATH"'"
  while true; do
    python3 - <<PY >> "'"$VLLM_STATS_PATH"'" 2>/dev/null || true
import json, time, urllib.request, re
out = {"ts": time.time(), "tokens_per_sec": None, "kv_bytes_per_token": None, "gpu_mem_used_bytes": None}
try:
    req = urllib.request.Request("http://127.0.0.1:'"$PORT"'/metrics", headers={"Accept": "text/plain"})
    body = urllib.request.urlopen(req, timeout=2).read().decode("utf-8", "replace")
    # vLLM Prometheus exposition format. Last line of each metric wins.
    for line in body.splitlines():
        if line.startswith("vllm:avg_generation_throughput_toks_per_s"):
            try: out["tokens_per_sec"] = float(line.rsplit(" ", 1)[-1])
            except Exception: pass
        elif line.startswith("vllm:gpu_cache_usage_perc"):
            try: out["gpu_cache_usage_perc"] = float(line.rsplit(" ", 1)[-1])
            except Exception: pass
        elif line.startswith("vllm:num_requests_running"):
            try: out["requests_running"] = float(line.rsplit(" ", 1)[-1])
            except Exception: pass
except Exception as e:
    out["error"] = str(e)
# kv_bytes_per_token = (block_size * num_layers * 2 (k,v) * head_dim * num_kv_heads * dtype_bytes) / block_size
# We do not have model dims here; the heartbeat agent computes the precise
# value. Surface a placeholder so the schema is stable for the consumer.
out["kv_bytes_per_token"] = None
print(json.dumps(out))
PY
    sleep '"$VLLM_STATS_INTERVAL_S"'
  done
' > /dev/null 2>&1 &
echo "[onstart-vllm] vllm-stats logger pid: $!"

# === heartbeat block (InferenceObservabilityAgent) ===
# Spawn the heartbeat scraper so cloud deployments emit the same JSONL
# observability stream as ad-hoc local serves. The contract is owned by
# training/scripts/inference/heartbeat.py; the consumer is the Eliza Cloud
# UI which reads /workspace/inference-stats.jsonl off the instance volume.
# Best-effort: if the heartbeat module isn't importable on this image
# (older container without the training/ tree mounted), we log and move on
# rather than blocking the PyWorker handoff.
HEARTBEAT_OUT="${HEARTBEAT_OUT:-/workspace/inference-stats.jsonl}"
HEARTBEAT_LABEL="${HEARTBEAT_LABEL:-vast-${MILADY_VAST_INSTANCE_ID:-unknown}}"
HEARTBEAT_INTERVAL="${HEARTBEAT_INTERVAL_SECONDS:-60}"
VLLM_METRICS_PORT="${VLLM_METRICS_PORT:-$PORT}"
HEARTBEAT_LOG="${HEARTBEAT_LOG:-/var/log/heartbeat.log}"
mkdir -p "$(dirname "$HEARTBEAT_LOG")"
if python3 -c "import scripts.inference.heartbeat" >/dev/null 2>&1; then
  echo "[onstart-vllm] starting heartbeat (out=$HEARTBEAT_OUT label=$HEARTBEAT_LABEL interval=${HEARTBEAT_INTERVAL}s)"
  nohup python3 -m scripts.inference.heartbeat \
    --vllm-metrics-url "http://127.0.0.1:${VLLM_METRICS_PORT}/metrics" \
    --out "$HEARTBEAT_OUT" \
    --interval-seconds "$HEARTBEAT_INTERVAL" \
    --label "$HEARTBEAT_LABEL" \
    > "$HEARTBEAT_LOG" 2>&1 &
  echo "[onstart-vllm] heartbeat pid: $!"
else
  echo "[onstart-vllm] heartbeat module not importable on this image; skipping observability scraper"
fi
# === end heartbeat block ===

# 5. Hand control to PyWorker (same contract as the llama-server flavor —
# tails $VLLM_LOG for "application startup complete" and registers with
# the Vast Serverless Engine).
echo "[onstart-vllm] launching PyWorker (model_alias=$SERVED_MODEL_NAME, log=$VLLM_LOG, port=$PORT)"
exec env \
  MODEL_ALIAS="$SERVED_MODEL_NAME" \
  LLAMA_SERVER_PORT="$PORT" \
  LLAMA_SERVER_LOG="$VLLM_LOG" \
  python3 worker.py
