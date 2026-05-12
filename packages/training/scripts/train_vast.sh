#!/usr/bin/env bash
# Provision a Vast.ai GPU instance, sync the training tree, and run a
# full-parameter SFT (APOLLO), DPO warmup, or GRPO RL pipeline on a
# Qwen3.5/3.6 model.
#
# Pipeline selection (--pipeline sft|dpo|grpo, default sft):
#   sft   — run train_local.py with APOLLO + Liger + FSDP (the historical
#           default; ALL GPU/cost projections below are for SFT).
#   dpo   — run train_dpo.py against an existing SFT checkpoint. Needs
#           DPO_SFT_CHECKPOINT pointing at the local final/ dir to seed.
#   grpo  — run train_grpo_verl.sh against an existing SFT+DPO checkpoint.
#           Needs DPO_CHECKPOINT pointing at the local SFT+DPO final/.
#           Allocates 2/4/8× H200 (or B200 fallback) per RL_STRATEGY.md.
#
# Same UX as scripts/train_nebius.sh — same subcommand set, same result —
# but on Vast.ai because 1×/2× RTX PRO 6000 Blackwell on Vast is meaningfully
# cheaper than equivalent H200/B200 capacity on Nebius for the smaller
# eliza-1 sizes.
#
# Default GPU target is auto-selected from REGISTRY_KEY (override via
# VAST_GPU_TARGET):
#   qwen3.5-2b  → blackwell6000-1x   (96 GB; 15.5 GB budget = 16% util)
#   qwen3.5-9b  → blackwell6000-1x   (96 GB; 80 GB budget   = 83% util)
#   qwen3.6-27b → b200-2x            (~366 GB; 190 GB budget = 52% util)
#
# Other targets (use VAST_GPU_TARGET=...):
#   blackwell6000-2x — 2× RTX PRO 6000 Blackwell, 192 GB total. Safe for
#                      27B at the registry's seq_len=65536 default
#                      (M35-lowered from 147456). Long-context experiments
#                      (--max-seq-len > 65k) still need b200-2x.
#   h100-2x          — 2× H100 SXM/NVL, 160 GB total. Insufficient for 27B
#                      at the registry budget; OK for 9B as a fallback.
#   h100-1x / h200-1x — single H100 / H200 alternates for 9B if the
#                       Blackwell pool is empty or you want faster bf16.
#
# 1B-token wall-time + cost projections (MFU=30%, Liger, FSDP if multi-GPU;
# computed via scripts/training/memory_calc.py time mode):
#
#                                wall    cost
#   qwen3.5-2b:
#     1× Blackwell 6000 (96 GB)  ~31 h   ~$41    DEFAULT  (cheapest)
#     1× H100 SXM      (80 GB)   ~11 h   ~$27    fastest cheap
#     2× B200          (366 GB)   ~3 h   ~$19    overkill but fast
#   qwen3.5-9b:
#     1× Blackwell 6000 (96 GB) ~139 h  ~$186    DEFAULT  (cheapest)
#     1× H100 SXM      (80 GB)   ~51 h  ~$121    nearly 3× faster; 80 GB tight
#     1× H200 SXM     (141 GB)   ~51 h  ~$162    same wall, more headroom
#     2× B200          (366 GB)  ~11 h   ~$84    fastest, also cheapish
#   qwen3.6-27b:
#     2× B200          (366 GB)  ~33 h  ~$253    DEFAULT (fast + safe)
#     2× H200 SXM     (282 GB)   ~76 h  ~$485    2× as slow, 2× as expensive
#     2× Blackwell 6000 (192 GB) ~208 h ~$558    cheapest $/hr, slowest;
#                                                fits at the registry's
#                                                seq=65536 default (190 GB
#                                                budget vs 192 GB cap).
#
# Required env:
#   VAST_API_KEY               # NEVER bake this into a committed file —
#                                pass it through the env. ``vastai set
#                                api-key`` also works (writes to
#                                ~/.config/vastai/vast_api_key).
#   HUGGING_FACE_HUB_TOKEN     # for gated Qwen access
#
# Optional env:
#   REGISTRY_KEY               # default: qwen3.6-27b
#   RUN_NAME                   # default: <registry-key>-apollo
#   VAST_GPU_TARGET            # default: auto-picked from REGISTRY_KEY
#   VAST_INSTANCE_LABEL        # default: eliza-train-vast-${REGISTRY_KEY//./-}
#   VAST_INSTANCE_ID           # set after `provision`; subsequent
#                                subcommands read this. Persisted to
#                                .vast_instance_id in the repo root so you
#                                can re-source it across shell sessions.
#   VAST_DOCKER_IMAGE          # default: pytorch/pytorch:2.6.0-cuda12.6-cudnn9-devel
#                                (CUDA 12.6 covers Blackwell sm_120 + SXM6)
#   VAST_DISK_GB               # default: 2048
#   VAST_MIN_DISK_GB           # default: 500 — search filter floor
#   VAST_MIN_INET_DOWN_MBPS    # default: 500
#   VAST_MIN_RELIABILITY       # default: 0.97
#   VAST_MIN_DURATION_DAYS     # default: 3
#   VAST_OFFER_ID              # skip search and use this offer id directly
#   QUANTIZE_AFTER             # default: read from REGISTRY_KEY's
#                                quantization_after tuple via model_registry.py
#                                (e.g. polarquant,turboquant,qjl,fp8,gguf-q4_k_m).
#                                Each name resolves to
#                                scripts/quantization/${name}_apply.py.
#   BENCHMARK_AFTER            # 1 = run eliza_bench (default 1)
#   BENCH_MAX_PER_BUCKET       # default: 200 (auto-lowered to 100 for 27B)
#   FSDP_WORLD_SIZE            # default: matches num_gpus of selected
#                                VAST_GPU_TARGET (1 for *-1x, 2 for *-2x)
#   CONFIRM_TEARDOWN           # set to 1 to allow `teardown` to actually
#                                destroy the instance (or pass --yes).
#   FORCE_REPROVISION          # set to 1 to allow `provision` to spin up
#                                a new instance even if .vast_instance_id
#                                already points at a live one.
#   ELIZA_SKIP_PREFLIGHT      # set to 1 to bypass scripts/preflight.sh's
#                                .preflight.ok gate before `provision`. Use
#                                only in operator emergencies — the gate
#                                exists because the six checks it runs
#                                (uv lock, pytest, schema, memory budget,
#                                local smoke, CUDA capability) cost cents
#                                locally and saved several hundred dollars
#                                of wasted Vast hours during the 2026-05
#                                smoke runs.
#   SSH_KEY                    # default: ~/.ssh/id_ed25519.pub
#
# Usage:
#   bash scripts/train_vast.sh search                           # list matching offers (read-only)
#   bash scripts/train_vast.sh provision                        # spin up the instance
#   bash scripts/train_vast.sh sync                             # rsync training/ to instance
#   bash scripts/train_vast.sh run                              # remote: launch training (pipeline-aware)
#   bash scripts/train_vast.sh quantize                         # remote: run QUANTIZE_AFTER list (SFT only)
#   bash scripts/train_vast.sh bench                            # remote: base + fine-tuned bench
#   bash scripts/train_vast.sh fetch                            # rsync checkpoints + benchmarks back
#   bash scripts/train_vast.sh provision-and-train --registry-key qwen3.5-9b --epochs 1 [--bootstrap rsync|hf] [--pipeline sft|dpo|grpo] [--dry-run]
#                                                               # provision + sync (or HF download) + run in one shot
#   bash scripts/train_vast.sh bootstrap-from-hf [--data-repo elizaos/eliza-1-training] \
#                                                [--pipeline-repo elizaos/eliza-1-pipeline]
#                                                               # remote: pull pipeline + dataset from HF (no local rsync)
#   bash scripts/train_vast.sh status                           # instance id, pipeline type, GPU, uptime, current step, ETA
#   bash scripts/train_vast.sh pull-checkpoints [--latest-only] # rsync checkpoint-* dirs back
#   bash scripts/train_vast.sh tail-logs                        # stream remote training stdout/stderr
#   bash scripts/train_vast.sh kill-and-teardown --yes          # graceful SIGTERM then destroy
#   bash scripts/train_vast.sh teardown --yes                   # destroy the instance immediately
#
# Pipeline-specific examples (--pipeline / PIPELINE env defaults to sft):
#   bash scripts/train_vast.sh --pipeline grpo provision-and-train \
#       --registry-key qwen3.5-2b --dry-run
#   PIPELINE=grpo DPO_CHECKPOINT=checkpoints/qwen3-5-9b-dpo/final \
#       bash scripts/train_vast.sh provision-and-train --registry-key qwen3.5-9b
#
# Or `bash scripts/train_vast.sh full` for the whole flow.
#
# Standardized env vars (preferred names; legacy names still honored):
#   VAST_API_KEY                  # vastai API key (or `vastai set api-key <k>`)
#   ELIZA_VAST_GPU_PREFERENCE    # csv, e.g. "B200,H200,H100,RTX5090". Picks the
#                                   first match against the auto-selected GPU
#                                   target. Override of VAST_GPU_TARGET.
#   ELIZA_VAST_DISK_GB           # default 200; aliases VAST_DISK_GB.
#   ELIZA_VAST_INSTANCE_ID       # set after provision; aliases VAST_INSTANCE_ID.
#                                   Persisted to .vast_instance_id in repo root.
#   ELIZA_VAST_MAX_USD           # per-job soft budget cap in USD. Crossing it
#                                   triggers a warn event from the watcher.
#                                   The hard cap (auto-teardown) is 1.5× this
#                                   value. Unset => no enforcement.

set -euo pipefail

# Greppable log prefix. Every log line in this script goes through log().
log() { echo "[train_vast] $*"; }
log_warn() { echo "[train_vast] WARNING: $*" >&2; }
log_err() { echo "[train_vast] ERROR: $*" >&2; }

# Nebius is deprecated. Refuse to run if the operator still has Nebius env
# loaded — that almost always means a stale .env file is bleeding through and
# nothing good comes from running Vast with Nebius creds active.
for nb in NEBIUS_API_KEY NEBIUS_PROJECT_ID NEBIUS_VM_PRESET NEBIUS_VM_REGION NEBIUS_INSTANCE_ID; do
  if [ -n "${!nb:-}" ]; then
    log_err "Nebius is deprecated; use Vast. Unset $nb before running this script."
    log_err "If you genuinely need the Nebius fallback, run scripts/train_nebius.sh directly."
    exit 2
  fi
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Standardized env names with backward-compat aliases. The ELIZA_VAST_*
# names are canonical; the older VAST_* names continue to work so existing
# operator muscle-memory and scratch shells don't break.
if [ -n "${ELIZA_VAST_INSTANCE_ID:-}" ] && [ -z "${VAST_INSTANCE_ID:-}" ]; then
  VAST_INSTANCE_ID="$ELIZA_VAST_INSTANCE_ID"
  export VAST_INSTANCE_ID
fi
if [ -n "${ELIZA_VAST_DISK_GB:-}" ] && [ -z "${VAST_DISK_GB:-}" ]; then
  VAST_DISK_GB="$ELIZA_VAST_DISK_GB"
  export VAST_DISK_GB
fi
# ELIZA_VAST_GPU_PREFERENCE is csv of GPU name fragments (B200,H200,H100,RTX5090).
# We map the first match to a VAST_GPU_TARGET. Operator can still override
# VAST_GPU_TARGET directly to skip this mapping.
if [ -n "${ELIZA_VAST_GPU_PREFERENCE:-}" ] && [ -z "${VAST_GPU_TARGET:-}" ]; then
  IFS=',' read -ra _gpu_pref <<< "$ELIZA_VAST_GPU_PREFERENCE"
  for _g in "${_gpu_pref[@]}"; do
    case "${_g^^}" in
      B200)    VAST_GPU_TARGET="b200-2x"; break ;;
      H200)    VAST_GPU_TARGET="h200-1x"; break ;;
      H100)    VAST_GPU_TARGET="h100-1x"; break ;;
      RTX5090|RTX_5090|BLACKWELL|BLACKWELL6000)
               VAST_GPU_TARGET="blackwell6000-1x"; break ;;
    esac
  done
  if [ -n "${VAST_GPU_TARGET:-}" ]; then
    export VAST_GPU_TARGET
    log "ELIZA_VAST_GPU_PREFERENCE=$ELIZA_VAST_GPU_PREFERENCE -> VAST_GPU_TARGET=$VAST_GPU_TARGET"
  fi
fi

# Pre-scan $@ for --pipeline and --registry-key BEFORE the defaults block
# below resolves DEFAULT_GPU_TARGET / DEFAULT_FSDP_WORLD_SIZE. We don't
# consume the args here — the per-subcommand parsers still see them — so
# both CLI flags and the env-var equivalents (PIPELINE / REGISTRY_KEY)
# stay in sync. DRY_RUN is also picked up here for the same reason.
DRY_RUN=0
_seen_pipeline=""
_seen_registry_key=""
_prev=""
for _arg in "$@"; do
  case "$_prev" in
    --pipeline)     _seen_pipeline="$_arg" ;;
    --registry-key) _seen_registry_key="$_arg" ;;
  esac
  case "$_arg" in
    --pipeline=*)     _seen_pipeline="${_arg#*=}" ;;
    --registry-key=*) _seen_registry_key="${_arg#*=}" ;;
    --dry-run)        DRY_RUN=1 ;;
  esac
  _prev="$_arg"
done
unset _prev _arg
if [ -n "$_seen_pipeline" ]; then
  PIPELINE="$_seen_pipeline"
fi
if [ -n "$_seen_registry_key" ]; then
  REGISTRY_KEY="$_seen_registry_key"
fi
unset _seen_pipeline _seen_registry_key

REGISTRY_KEY="${REGISTRY_KEY:-qwen3.6-27b}"
# PIPELINE selects which training stage the launcher drives end-to-end on the
# remote box. Default = SFT (the historical behaviour); --pipeline dpo|grpo
# overrides via the CLI pre-scan above or via the PIPELINE env var.
PIPELINE="${PIPELINE:-sft}"

# Auto-pick the GPU target and FSDP world size from (PIPELINE, REGISTRY_KEY).
# SFT defaults (cheapest fit for full-parameter Liger+APOLLO):
#   2B/9B → blackwell6000-1x (96 GB)
#   27B   → b200-2x          (366 GB — 192 GB blackwell-2x is too tight)
# GRPO defaults (verl splits actor train + rollout across the device pool;
# per RL_STRATEGY.md hardware budgets):
#   2B  → h200-2x  (1 train + 1 rollout)
#   9B  → h200-4x  (1 train + 3 rollout shards)
#   27B → h200-8x  (4 train + 4 rollout)
# DPO defaults use the same SFT targets — DPO is forward+backward over the
# preference pairs, no rollout, so it fits in the SFT memory budget.
case "$PIPELINE" in
  sft|dpo)
    case "$REGISTRY_KEY" in
      qwen3.5-2b|qwen3.5-9b)
        DEFAULT_GPU_TARGET="blackwell6000-1x"
        DEFAULT_FSDP_WORLD_SIZE=1
        ;;
      qwen3.6-27b)
        DEFAULT_GPU_TARGET="b200-2x"
        DEFAULT_FSDP_WORLD_SIZE=2
        ;;
      *)
        DEFAULT_GPU_TARGET="blackwell6000-2x"
        DEFAULT_FSDP_WORLD_SIZE=2
        ;;
    esac
    ;;
  grpo)
    case "$REGISTRY_KEY" in
      qwen3.5-2b)
        DEFAULT_GPU_TARGET="h200-2x"
        DEFAULT_FSDP_WORLD_SIZE=2
        ;;
      qwen3.5-9b)
        DEFAULT_GPU_TARGET="h200-4x"
        DEFAULT_FSDP_WORLD_SIZE=4
        ;;
      qwen3.6-27b)
        DEFAULT_GPU_TARGET="h200-8x"
        DEFAULT_FSDP_WORLD_SIZE=8
        ;;
      *)
        DEFAULT_GPU_TARGET="h200-4x"
        DEFAULT_FSDP_WORLD_SIZE=4
        ;;
    esac
    ;;
  *)
    log_err "unknown PIPELINE=$PIPELINE (must be sft|dpo|grpo)"
    exit 2
    ;;
esac

VAST_GPU_TARGET="${VAST_GPU_TARGET:-$DEFAULT_GPU_TARGET}"
# Parse FSDP world size from the resolved GPU target's -Nx suffix so an
# operator override of VAST_GPU_TARGET stays consistent with FSDP_WORLD_SIZE
# without a second env var.
case "$VAST_GPU_TARGET" in
  *-1x) FSDP_WORLD_SIZE="${FSDP_WORLD_SIZE:-1}" ;;
  *-2x) FSDP_WORLD_SIZE="${FSDP_WORLD_SIZE:-2}" ;;
  *-4x) FSDP_WORLD_SIZE="${FSDP_WORLD_SIZE:-4}" ;;
  *-8x) FSDP_WORLD_SIZE="${FSDP_WORLD_SIZE:-8}" ;;
  *)    FSDP_WORLD_SIZE="${FSDP_WORLD_SIZE:-$DEFAULT_FSDP_WORLD_SIZE}" ;;
esac

# The transformer decoder-layer class FSDP's TRANSFORMER_BASED_WRAP policy
# wraps. Qwen3-0.6B/1.7B/4B are plain Qwen3 (`Qwen3DecoderLayer`); the larger
# Qwen3.5/Qwen3.6 tiers (qwen3.5-2b/9b, qwen3.6-27b) use `Qwen3_5DecoderLayer`.
# Wrapping the wrong class name silently degrades FSDP to wrapping the whole
# model in one unit (huge all-gather peaks → OOM).
case "$REGISTRY_KEY" in
  qwen3-0.6b|qwen3-1.7b|qwen3-4b) FSDP_WRAP_CLS="Qwen3DecoderLayer" ;;
  *)                              FSDP_WRAP_CLS="Qwen3_5DecoderLayer" ;;
esac
FSDP_WRAP_CLS="${FSDP_WRAP_CLS_OVERRIDE:-$FSDP_WRAP_CLS}"

case "$PIPELINE" in
  # Preserve the legacy SFT run-name suffix so existing checkpoint dirs
  # and HF publish targets that hardcode `${REGISTRY_KEY//./-}-apollo`
  # keep resolving. DPO and GRPO get the pipeline-named suffix since
  # they're new surfaces.
  sft)  RUN_NAME="${RUN_NAME:-${REGISTRY_KEY//./-}-apollo}" ;;
  dpo)  RUN_NAME="${RUN_NAME:-${REGISTRY_KEY//./-}-dpo}" ;;
  grpo) RUN_NAME="${RUN_NAME:-${REGISTRY_KEY//./-}-grpo}" ;;
esac

VAST_INSTANCE_LABEL="${VAST_INSTANCE_LABEL:-eliza-train-vast-${REGISTRY_KEY//./-}}"
VAST_DOCKER_IMAGE="${VAST_DOCKER_IMAGE:-pytorch/pytorch:2.6.0-cuda12.6-cudnn9-devel}"
VAST_DISK_GB="${VAST_DISK_GB:-2048}"

# QUANTIZE_AFTER default is read from model_registry.py so the registry stays
# the single source of truth. Each name resolves to
# `scripts/quantization/${name}_apply.py` in quantize_remote() below.
# Fallback is the original literal default if the registry import fails (e.g.
# when running this script outside `uv run`); the literal still references
# only quants whose apply.py exists.
DEFAULT_QUANTIZE_AFTER="$(cd "$ROOT" && uv run python -c "from scripts.training.model_registry import get; print(','.join(get('${REGISTRY_KEY}').quantization_after))" 2>/dev/null || echo "polarquant,turboquant,qjl,fp8,gguf-q4_k_m")"
QUANTIZE_AFTER="${QUANTIZE_AFTER:-${DEFAULT_QUANTIZE_AFTER}}"
BENCHMARK_AFTER="${BENCHMARK_AFTER:-1}"

# eliza_bench at --max-per-bucket 200 with --max-new-tokens=512 generates
# ~600 forward passes per bucket × 4 buckets × 5 model variants ≈ 12k
# generations. On a 27B bf16 model this is unnecessarily slow; cap to
# 100/bucket for 27B unless caller overrides.
if [ -z "${BENCH_MAX_PER_BUCKET:-}" ]; then
  case "$REGISTRY_KEY" in
    qwen3.6-27b) BENCH_MAX_PER_BUCKET=100 ;;
    *)           BENCH_MAX_PER_BUCKET=200 ;;
  esac
fi

SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519.pub}"
REMOTE_TRAIN_DIR="/workspace/training"
INSTANCE_ID_FILE="$ROOT/.vast_instance_id"
# Sidecar to .vast_instance_id storing the pipeline type so `status` and
# every subsequent subcommand can recover which pipeline was provisioned
# (sft|dpo|grpo) without having to re-pass --pipeline on each invocation.
PIPELINE_TYPE_FILE="$ROOT/.vast_pipeline_type"

# `vastai` reads VAST_API_KEY from the env automatically; we don't echo or
# persist it from this script. If the user already ran `vastai set api-key`
# we don't need the env var at all — that's fine.
if [ -z "${VAST_API_KEY:-}" ] && [ ! -f "$HOME/.config/vastai/vast_api_key" ]; then
  echo "error: set VAST_API_KEY or run 'vastai set api-key <key>' first" >&2
  exit 2
fi

# Pick out the first non-flag positional as the subcommand so callers can
# put the global --pipeline / --registry-key / --dry-run flags either
# before or after the subcommand (e.g.
#   train_vast.sh --pipeline grpo provision-and-train --registry-key K
#   train_vast.sh provision-and-train --pipeline grpo --registry-key K
# both work). Subcommand handlers re-parse their own flags from
# SUBCMD_ARGS, so we forward everything except the matched subcommand.
cmd="help"
SUBCMD_ARGS=()
_seen_cmd=0
_skip_next=0
for _arg in "$@"; do
  if [ "$_skip_next" -eq 1 ]; then
    SUBCMD_ARGS+=("$_arg")
    _skip_next=0
    continue
  fi
  case "$_arg" in
    --pipeline|--registry-key)
      # Two-token flag — keep both tokens in SUBCMD_ARGS for the handler.
      SUBCMD_ARGS+=("$_arg")
      _skip_next=1
      ;;
    --pipeline=*|--registry-key=*|--dry-run|--*)
      # Single-token flag — pass through.
      SUBCMD_ARGS+=("$_arg")
      ;;
    *)
      if [ "$_seen_cmd" -eq 0 ]; then
        cmd="$_arg"
        _seen_cmd=1
      else
        SUBCMD_ARGS+=("$_arg")
      fi
      ;;
  esac
done
unset _arg _seen_cmd _skip_next

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

require_instance_id() {
  if [ -z "${VAST_INSTANCE_ID:-}" ] && [ -f "$INSTANCE_ID_FILE" ]; then
    VAST_INSTANCE_ID="$(cat "$INSTANCE_ID_FILE")"
    export VAST_INSTANCE_ID
  fi
  if [ -z "${VAST_INSTANCE_ID:-}" ]; then
    echo "error: VAST_INSTANCE_ID not set and $INSTANCE_ID_FILE missing." >&2
    echo "  run 'bash scripts/train_vast.sh provision' first, or export VAST_INSTANCE_ID=<id>" >&2
    exit 2
  fi
}

ssh_endpoint() {
  # Prints "USER HOST PORT" — split with `read user host port < <(...)`.
  ( cd "$ROOT" && python3 -m scripts.lib.vast ssh "$VAST_INSTANCE_ID" )
}

ssh_run() {
  # ssh_run "<remote bash>" — runs the command on the Vast instance.
  local user host port
  read -r user host port < <(ssh_endpoint)
  ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
      -o ServerAliveInterval=30 \
      -p "$port" "$user@$host" "$@"
}

rsync_remote() {
  # rsync_remote <direction:to|from> <local-or-remote> <remote-or-local> [extra-rsync-args...]
  local direction="$1"; shift
  local user host port
  read -r user host port < <(ssh_endpoint)
  local src dst
  if [ "$direction" = "to" ]; then
    src="$1"; dst="$user@$host:$2"
  else
    src="$user@$host:$1"; dst="$2"
  fi
  shift 2
  rsync -avh --partial --info=progress2 \
    -e "ssh -p $port -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null" \
    "$@" \
    "$src" "$dst"
}

# ---------------------------------------------------------------------------
# subcommands
# ---------------------------------------------------------------------------

search_offers() {
  echo "[train_vast] [search] target=$VAST_GPU_TARGET — top offers:"
  ( cd "$ROOT" && python3 -m scripts.lib.vast list "$VAST_GPU_TARGET" --limit 12 )
}

preflight_gate() {
  # Refuse to provision unless scripts/preflight.sh succeeded within the
  # current calendar hour. The gate catches uv lock drift, broken unit
  # tests, schema corruption, memory-budget overshoot, stale local smoke,
  # and CUDA capability mismatches BEFORE we pay for cloud hardware.
  if [ "${ELIZA_SKIP_PREFLIGHT:-0}" = "1" ]; then
    log_warn "ELIZA_SKIP_PREFLIGHT=1 — bypassing scripts/preflight.sh gate."
    log_warn "This is an emergency override; expect provisioning failures if"
    log_warn "any of the six pre-flight checks would have failed."
    return 0
  fi

  local gate_file="$ROOT/.preflight.ok"
  if [ ! -f "$gate_file" ]; then
    log_err "pre-flight gate file $gate_file is missing."
    log_err "Run:  bash scripts/preflight.sh"
    log_err "(or ELIZA_SKIP_PREFLIGHT=1 to bypass — emergency only)"
    exit 2
  fi

  # Stale gate = older than the current calendar hour. We compare the
  # YYYYMMDDHH stamp of the file's mtime against `now` so a 14:59 success
  # doesn't license a 15:01 provision — the operator must re-run preflight
  # if anything has rolled past the hour boundary.
  local file_stamp now_stamp
  file_stamp="$(date -d "@$(stat -c %Y "$gate_file")" +%Y%m%d%H 2>/dev/null || \
                stat -f %Sm -t %Y%m%d%H "$gate_file")"
  now_stamp="$(date +%Y%m%d%H)"
  if [ "$file_stamp" != "$now_stamp" ]; then
    log_err "pre-flight gate $gate_file is stale (stamped $file_stamp, now $now_stamp)."
    log_err "Re-run:  bash scripts/preflight.sh"
    log_err "(or ELIZA_SKIP_PREFLIGHT=1 to bypass — emergency only)"
    exit 2
  fi

  log "[provision] pre-flight gate $gate_file fresh (within current hour)"
}

provision() {
  # GRPO is materially more expensive than SFT — verl needs separate
  # train + rollout GPUs and the recommended budget jumps from 1× to 8×.
  # Log a one-liner so the operator sees the $/hr delta before billing.
  if [ "$PIPELINE" = "grpo" ]; then
    log_warn "GRPO pipeline allocates $VAST_GPU_TARGET — meaningfully pricier than SFT."
    log_warn "Per RL_STRATEGY.md: 2B ~24h, 9B ~24-48h, 27B ~48h on H200. Plan budget accordingly."
  fi

  # Dry-run support: print the planned action and exit. Used by smoke
  # tests + operators previewing cost before paying for hardware.
  if [ "${DRY_RUN:-0}" = "1" ]; then
    log "[provision] DRY_RUN=1 — planned provision:"
    log "  pipeline=$PIPELINE"
    log "  registry_key=$REGISTRY_KEY"
    log "  vast_gpu_target=$VAST_GPU_TARGET"
    log "  fsdp_world_size=$FSDP_WORLD_SIZE"
    log "  instance_label=$VAST_INSTANCE_LABEL"
    log "  docker_image=$VAST_DOCKER_IMAGE"
    log "  disk_gb=$VAST_DISK_GB"
    log "[provision] dry-run complete — no instance created."
    return 0
  fi

  preflight_gate

  # Idempotence guard: refuse to spin up a new instance when one already
  # exists and is alive. Set FORCE_REPROVISION=1 to override (e.g. when
  # the old instance hung in 'loading' and you want to abandon it).
  if [ -f "$INSTANCE_ID_FILE" ] && [ "${FORCE_REPROVISION:-0}" != "1" ]; then
    local existing_id
    existing_id="$(cat "$INSTANCE_ID_FILE")"
    if [ -n "$existing_id" ] && \
       ( cd "$ROOT" && python3 -m scripts.lib.vast alive "$existing_id" ) 2>/dev/null; then
      echo "[train_vast] [provision] instance $existing_id already alive — skipping create."
      echo "[train_vast] [provision] set FORCE_REPROVISION=1 to spin up a new one anyway,"
      echo "[train_vast] [provision] or 'bash scripts/train_vast.sh teardown --yes' first."
      export VAST_INSTANCE_ID="$existing_id"
      return 0
    fi
  fi

  if [ -z "${VAST_OFFER_ID:-}" ]; then
    echo "[train_vast] [provision] picking cheapest offer for $VAST_GPU_TARGET"
    # `python -m scripts.lib.vast pick` emits KEY=VAL lines safe to eval.
    eval "$(cd "$ROOT" && python3 -m scripts.lib.vast pick "$VAST_GPU_TARGET")"
    VAST_OFFER_ID="$ID"
    echo "[train_vast] [provision] picked offer $VAST_OFFER_ID — $GPU_NAME ×$NUM_GPUS, ${GPU_TOTAL_RAM_GB}GB total, \$${DPH_TOTAL}/hr in $GEOLOCATION"
  else
    echo "[train_vast] [provision] using user-supplied VAST_OFFER_ID=$VAST_OFFER_ID"
  fi

  if [ ! -f "$SSH_KEY" ]; then
    echo "error: ssh key $SSH_KEY missing — set SSH_KEY=<path-to-pub>" >&2
    exit 2
  fi

  # `--ssh --direct` puts an OpenSSH server in the container and exposes
  # a direct port (no bouncer hop) — that's what makes rsync fast enough
  # for multi-GB dataset transfers. The PyTorch CUDA 12.6 image already
  # has python, torch, and the build toolchain; we add tmux/jq/rsync via
  # apt.
  echo "[train_vast] [provision] creating instance label=$VAST_INSTANCE_LABEL image=$VAST_DOCKER_IMAGE disk=${VAST_DISK_GB}GB"
  local create_out
  create_out="$(vastai create instance "$VAST_OFFER_ID" \
    --image "$VAST_DOCKER_IMAGE" \
    --disk "$VAST_DISK_GB" \
    --label "$VAST_INSTANCE_LABEL" \
    --ssh \
    --direct \
    --cancel-unavail \
    --raw)"
  echo "$create_out"

  local new_id
  new_id="$(echo "$create_out" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('new_contract',''))")"
  if [ -z "$new_id" ]; then
    echo "error: failed to parse new_contract from create output" >&2
    exit 1
  fi
  echo "$new_id" > "$INSTANCE_ID_FILE"
  echo "$PIPELINE" > "$PIPELINE_TYPE_FILE"
  export VAST_INSTANCE_ID="$new_id"
  echo "[train_vast] [provision] instance id $new_id (saved to $INSTANCE_ID_FILE, pipeline=$PIPELINE → $PIPELINE_TYPE_FILE)"

  echo "[train_vast] [provision] attaching ssh key $SSH_KEY"
  vastai attach ssh "$new_id" "$(cat "$SSH_KEY")"

  echo "[train_vast] [provision] waiting for instance to reach 'running'"
  ( cd "$ROOT" && python3 -m scripts.lib.vast wait "$new_id" --timeout 1200 )

  echo "[train_vast] [provision] installing system deps over ssh"
  ssh_run 'set -euo pipefail
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y
    apt-get install -y rsync git tmux jq curl ca-certificates build-essential python3-dev
    curl -LsSf https://astral.sh/uv/install.sh | sh
    mkdir -p /workspace
  '
}

sync_tree() {
  require_instance_id
  echo "[train_vast] [sync] rsyncing training/ to instance $VAST_INSTANCE_ID:$REMOTE_TRAIN_DIR"
  ssh_run "mkdir -p $REMOTE_TRAIN_DIR"
  rsync_remote to "$ROOT/" "$REMOTE_TRAIN_DIR/" \
    --delete \
    --exclude '.venv/' \
    --exclude 'data/raw/' \
    --exclude 'checkpoints/' \
    --exclude 'wandb/' \
    --exclude '.vast_instance_id'
  echo "[train_vast] [sync] sending data/final/ (active artefacts only — WIP/historical jsonls excluded)"
  # train_local.py:108 defaults --train-file to data/final/train.jsonl, which is
  # the canonical name (regardless of how it was produced — train_final.jsonl
  # is a historical alias used during the deslop sprint and is symlinked or
  # renamed before each provision). Keep this filter aligned with the trainer's
  # default path; otherwise sync ships an empty data/final/ to the remote.
  rsync_remote to "$ROOT/data/final/" "$REMOTE_TRAIN_DIR/data/final/" \
    --include='train.jsonl' \
    --include='val.jsonl' \
    --include='test.jsonl' \
    --include='manifest.json' \
    --include='manifest_final.json' \
    --include='README.md' \
    --include='*/' \
    --exclude='*'
  # When the run trains on the benchmark-aligned combined corpus
  # (TRAIN_FILE=data/final-eliza1-fullcorpus/train.jsonl) or the
  # 0.6b SFT mix-in (datasets/eliza1-sft-0_6b/), ship those too. The
  # generic --exclude 'data/raw/' above keeps the slim tree small;
  # these two trees are the canonical fine-tune corpora and must go.
  if [ "${SYNC_FULLCORPUS_SOURCES:-0}" = "1" ] || [ -d "$ROOT/data/final-eliza1-fullcorpus" ]; then
    if [ -d "$ROOT/data/final-eliza1-fullcorpus" ]; then
      echo "[train_vast] [sync] sending data/final-eliza1-fullcorpus/ (combined benchmark-aligned + broad-mix corpus)"
      rsync_remote to "$ROOT/data/final-eliza1-fullcorpus/" "$REMOTE_TRAIN_DIR/data/final-eliza1-fullcorpus/"
    fi
    if [ -d "$ROOT/datasets/eliza1-sft-0_6b" ]; then
      echo "[train_vast] [sync] sending datasets/eliza1-sft-0_6b/ (the 0.6b SFT corpus)"
      rsync_remote to "$ROOT/datasets/eliza1-sft-0_6b/" "$REMOTE_TRAIN_DIR/datasets/eliza1-sft-0_6b/"
    fi
  fi
}

run_remote() {
  require_instance_id
  # Smoke-mode override: when SMOKE_MODE=1, the launcher passes
  # `--max-samples`, `--max-seq-len` so the training step can finish in
  # ~10-15 min on cheap hardware. We still pass `--registry-key` so APOLLO
  # config + memory budget come from the registry; `--max-seq-len` then
  # overrides only the sequence length.
  local extra_train_flags=""
  if [ "${SMOKE_MODE:-0}" = "1" ]; then
    local n="${SMOKE_MAX_SAMPLES:-256}"
    local seq="${SMOKE_MAX_SEQ_LEN:-8192}"
    extra_train_flags="--max-samples $n --max-seq-len $seq"
    echo "[train_vast] [run] SMOKE_MODE=1 — capping at $n samples, seq=$seq"
  fi

  # Hardware floor for 27B. The smoke runs (2026-05-04) confirmed that
  # 2x RTX PRO 6000 Blackwell (96 GB/GPU, 192 GB total) OOMs even at seq=2048
  # under FSDP-2 with APOLLO-Mini + Liger + FA3 + grad ckpt. The empirical
  # backward all-gather peak overshoots memory_calc's static estimate by
  # ~25 GB on this hardware tier. Refuse the combo and point operators at
  # b200-2x or h200-2x (default) or blackwell6000-4x (192 GB/rank under
  # FSDP-4 leaves real headroom).
  if [ "$REGISTRY_KEY" = "qwen3.6-27b" ] \
     && [ "$VAST_GPU_TARGET" = "blackwell6000-2x" ] \
     && [ "${ELIZA_FORCE_27B_BLACKWELL2X:-0}" != "1" ]; then
    log_err "27B on blackwell6000-2x has been empirically shown to OOM"
    log_err "(smoke 2026-05-04 OOM'd at seq=2048 with all optimizations on)."
    log_err "Use VAST_GPU_TARGET=b200-2x (default), h200-2x, or blackwell6000-4x."
    log_err "Set ELIZA_FORCE_27B_BLACKWELL2X=1 to bypass and accept OOM risk."
    exit 2
  fi
  echo "[train_vast] [run] launching APOLLO full-finetune (registry=$REGISTRY_KEY run=$RUN_NAME world=$FSDP_WORLD_SIZE$([ -n "$extra_train_flags" ] && echo " smoke") )"
  # Heredoc through bash -lc so the remote process tree dies when we
  # disconnect. For real long-running training, run this inside `tmux new
  # -d -s train 'bash scripts/train_vast.sh run'` on the local side.
  # APOLLO is the canonical optimizer for ALL eliza-1 sizes (see
  # model_registry.py: 2B/9B → apollo_mini, 27B → apollo_mini @ rank=512).
  # train_local.py builds it via _ElizaSFTTrainer.create_optimizer, which
  # routes 2-D weights to the projector + everything else to plain AdamW.
  # Under FSDP1 with --fsdp_use_orig_params true (set below), named_parameters()
  # exposes original 2-D shapes so the routing works correctly. Operators
  # who need a different optimizer can override via ELIZA_TRAINER_OPTIM,
  # but APOLLO is the default — do not switch to plain AdamW for 27B
  # (its 8-byte fp32 moments would alone consume ~108 GB/rank under FSDP-2).
  ssh_run "bash -lc '
    set -euo pipefail
    cd $REMOTE_TRAIN_DIR
    export PATH=\$HOME/.local/bin:\$PATH
    export HF_HOME=/workspace/hf-cache
    mkdir -p \$HF_HOME
    uv sync --extra train
    if [ -n \"\${HUGGING_FACE_HUB_TOKEN:-}\" ]; then
      # hf is the supported HuggingFace CLI in huggingface_hub 1.x.
      uv run hf auth login --token \"\$HUGGING_FACE_HUB_TOKEN\" --add-to-git-credential
    fi
    uv run --extra train accelerate launch \\
      --num_processes $FSDP_WORLD_SIZE \\
      --mixed_precision bf16 \\
      --use_fsdp \\
      --fsdp_sharding_strategy FULL_SHARD \\
      --fsdp_state_dict_type SHARDED_STATE_DICT \\
      --fsdp_offload_params false \\
      --fsdp_cpu_ram_efficient_loading true \\
      --fsdp_sync_module_states true \\
      --fsdp_use_orig_params true \\
      --fsdp_auto_wrap_policy TRANSFORMER_BASED_WRAP \\
      --fsdp_transformer_layer_cls_to_wrap $FSDP_WRAP_CLS \\
      --fsdp_backward_prefetch BACKWARD_PRE \\
      scripts/train_local.py \\
        --registry-key $REGISTRY_KEY \\
        --run-name $RUN_NAME \\
        --epochs 1 \\
        --lr 1e-5 \\
        --full-finetune \\
        --use-liger on $extra_train_flags
  '"
}

run_grpo_remote() {
  # GRPO entry point. Invokes scripts/train_grpo_verl.sh on the remote
  # box. verl handles the FSDP train + vLLM rollout split internally —
  # we just allocate the GPUs (via VAST_GPU_TARGET → h200-{2,4,8}x) and
  # forward the registry key + DPO checkpoint path. Per-stage hardware
  # budget comes from RL_STRATEGY.md.
  require_instance_id

  # GRPO needs the SFT+DPO checkpoint as its seed. Default to the
  # checkpoint dir produced by the DPO pipeline; operators override
  # with DPO_CHECKPOINT when running against a custom name.
  local dpo_ckpt_default="checkpoints/${REGISTRY_KEY//./-}-dpo/final"
  local dpo_checkpoint="${DPO_CHECKPOINT:-$dpo_ckpt_default}"
  local output_dir="checkpoints/${RUN_NAME}"

  # Smoke-mode override: cap rollouts + response length so a GRPO smoke
  # finishes in ~15 min instead of ~24h.
  local rollouts="${GRPO_ROLLOUTS:-8}"
  local rollout_batch="${GRPO_ROLLOUT_BATCH:-8}"
  local epochs="${GRPO_EPOCHS:-1}"
  local max_response_len="${GRPO_MAX_RESPONSE_LEN:-1024}"
  if [ "${SMOKE_MODE:-0}" = "1" ]; then
    rollouts="${SMOKE_GRPO_ROLLOUTS:-2}"
    rollout_batch="${SMOKE_GRPO_ROLLOUT_BATCH:-2}"
    max_response_len="${SMOKE_GRPO_MAX_RESPONSE_LEN:-256}"
    log "[run-grpo] SMOKE_MODE=1 — rollouts=$rollouts batch=$rollout_batch max_resp=$max_response_len"
  fi

  log "[run-grpo] verl GRPO (registry=$REGISTRY_KEY dpo_ckpt=$dpo_checkpoint world=$FSDP_WORLD_SIZE)"
  log "[run-grpo] rollouts=$rollouts rollout_batch=$rollout_batch epochs=$epochs max_response_len=$max_response_len"

  # verl pulls in a different torch ABI than the SFT/train extra (vllm
  # pins torch.cuda differently), so we sync the `rl` extra rather than
  # `train`. train_grpo_verl.sh tolerates a missing verl install — it
  # writes the config + exits with a clear message — so the launcher
  # still functions when the remote venv hasn't been bootstrapped yet.
  ssh_run "bash -lc '
    set -euo pipefail
    cd $REMOTE_TRAIN_DIR
    export PATH=\$HOME/.local/bin:\$PATH
    export HF_HOME=/workspace/hf-cache
    mkdir -p \$HF_HOME
    uv sync --extra rl
    if [ -n \"\${HUGGING_FACE_HUB_TOKEN:-}\" ]; then
      uv run hf auth login --token \"\$HUGGING_FACE_HUB_TOKEN\" --add-to-git-credential
    fi
    uv run --extra rl bash scripts/train_grpo_verl.sh \\
      --registry-key $REGISTRY_KEY \\
      --dpo-checkpoint $dpo_checkpoint \\
      --output-dir $output_dir \\
      --rollouts $rollouts \\
      --rollout-batch $rollout_batch \\
      --epochs $epochs \\
      --max-response-len $max_response_len \\
      --gpus $FSDP_WORLD_SIZE
  '"
}

# Pipeline-aware dispatcher for the `run` subcommand. SFT and DPO both
# go through run_remote() (DPO uses train_dpo.py which honours the same
# accelerate config; the DPO command line is left to the existing
# operator-facing wrapper). GRPO goes through run_grpo_remote().
run_for_pipeline() {
  case "$PIPELINE" in
    sft|dpo) run_remote ;;
    grpo)    run_grpo_remote ;;
    *)
      log_err "run_for_pipeline: unknown PIPELINE=$PIPELINE"
      exit 2
      ;;
  esac
}

quantize_remote() {
  require_instance_id
  echo "[train_vast] [quantize] running $QUANTIZE_AFTER on instance $VAST_INSTANCE_ID"
  IFS=',' read -ra qs <<< "$QUANTIZE_AFTER"
  for q in "${qs[@]}"; do
    echo "  -> $q"
    ssh_run "bash -lc '
      set -euo pipefail
      cd $REMOTE_TRAIN_DIR
      export PATH=\$HOME/.local/bin:\$PATH
      uv run --extra train python scripts/quantization/${q}_apply.py \\
        --model checkpoints/$RUN_NAME/final \\
        --output checkpoints/$RUN_NAME/final-${q} \\
        --calibration data/final/val.jsonl \\
        --calibration-samples 128
    '"
  done
}

bench_remote() {
  require_instance_id
  if [ "$BENCHMARK_AFTER" != "1" ]; then
    echo "[train_vast] [bench] BENCHMARK_AFTER=0 — skipping"
    return 0
  fi
  echo "[train_vast] [bench] eliza_bench: base + finetuned + quantized (max_per_bucket=$BENCH_MAX_PER_BUCKET)"
  ssh_run "bash -lc '
    set -euo pipefail
    cd $REMOTE_TRAIN_DIR
    export PATH=\$HOME/.local/bin:\$PATH
    base_id=\$(uv run --extra train python -c \"from scripts.training.model_registry import get; print(get(\\\"$REGISTRY_KEY\\\").hf_id)\")
    uv run --extra train python scripts/benchmark/eliza_bench.py \\
        --model \$base_id \\
        --out-dir benchmarks/$RUN_NAME/base \\
        --max-per-bucket $BENCH_MAX_PER_BUCKET
    uv run --extra train python scripts/benchmark/eliza_bench.py \\
        --model checkpoints/$RUN_NAME/final \\
        --out-dir benchmarks/$RUN_NAME/finetuned \\
        --max-per-bucket $BENCH_MAX_PER_BUCKET
  '"
  IFS=',' read -ra qs <<< "$QUANTIZE_AFTER"
  for q in "${qs[@]}"; do
    ssh_run "bash -lc '
      set -euo pipefail
      cd $REMOTE_TRAIN_DIR
      export PATH=\$HOME/.local/bin:\$PATH
      if [ -d checkpoints/$RUN_NAME/final-${q} ]; then
        uv run --extra train python scripts/benchmark/eliza_bench.py \\
          --model checkpoints/$RUN_NAME/final-${q} \\
          --out-dir benchmarks/$RUN_NAME/${q} \\
          --max-per-bucket $BENCH_MAX_PER_BUCKET
      fi
    '" || true
  done
}

fetch() {
  require_instance_id
  echo "[train_vast] [fetch] rsyncing checkpoints + benchmarks + logs back"
  mkdir -p "$ROOT/checkpoints/$RUN_NAME" "$ROOT/benchmarks/$RUN_NAME" "$ROOT/logs"
  # Checkpoints (final + every final-<quant> sidecar dir).
  rsync_remote from "$REMOTE_TRAIN_DIR/checkpoints/$RUN_NAME/" "$ROOT/checkpoints/$RUN_NAME/"
  # Benchmarks (results.json per variant).
  rsync_remote from "$REMOTE_TRAIN_DIR/benchmarks/$RUN_NAME/" "$ROOT/benchmarks/$RUN_NAME/" || true
  # Training logs at /workspace/*.log (train.log, quant_*.log, bench_*.log)
  # plus the .ok sentinels.
  rsync_remote from "/workspace/" "$ROOT/logs/$RUN_NAME/" --include='*.log' --include='*.ok' --exclude='*' || true
  # wandb run dirs if the user enabled wandb.
  rsync_remote from "$REMOTE_TRAIN_DIR/wandb/" "$ROOT/wandb/" || true
}

teardown() {
  require_instance_id
  # Safety guard: destroying an instance is permanent and bills accrue
  # until destruction. Require explicit opt-in so a wayward
  # `bash scripts/train_vast.sh teardown` can't nuke a multi-day run.
  local confirmed=0
  for arg in "$@"; do
    case "$arg" in
      --yes|--force|-y) confirmed=1 ;;
    esac
  done
  if [ "${CONFIRM_TEARDOWN:-0}" = "1" ]; then
    confirmed=1
  fi
  if [ "$confirmed" -ne 1 ]; then
    echo "[train_vast] [teardown] refusing to destroy instance $VAST_INSTANCE_ID without confirmation."
    echo "[train_vast] [teardown] re-run with --yes  OR  CONFIRM_TEARDOWN=1 bash scripts/train_vast.sh teardown"
    exit 2
  fi
  log "destroying instance $VAST_INSTANCE_ID"
  vastai destroy instance "$VAST_INSTANCE_ID"
  rm -f "$INSTANCE_ID_FILE" "$PIPELINE_TYPE_FILE"
}

# ---------------------------------------------------------------------------
# new subcommands: provision-and-train, status, pull-checkpoints,
# tail-logs, kill-and-teardown
# ---------------------------------------------------------------------------

provision_and_train() {
  # Parse --registry-key / --epochs / --bootstrap / --pipeline / --dry-run.
  # --pipeline and --dry-run are also captured by the top-level pre-scan so
  # GPU defaults resolve correctly; we re-accept them here for parser
  # clarity and to fail loudly on unknown args (instead of silently
  # dropping them).
  local epochs=""
  local rk=""
  local bootstrap_mode="rsync"
  local data_repo="elizaos/eliza-1-training"
  local pipeline_repo="elizaos/eliza-1-pipeline"
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --registry-key) rk="$2"; shift 2 ;;
      --registry-key=*) rk="${1#*=}"; shift ;;
      --epochs) epochs="$2"; shift 2 ;;
      --epochs=*) epochs="${1#*=}"; shift ;;
      --bootstrap) bootstrap_mode="$2"; shift 2 ;;
      --bootstrap=*) bootstrap_mode="${1#*=}"; shift ;;
      --data-repo) data_repo="$2"; shift 2 ;;
      --data-repo=*) data_repo="${1#*=}"; shift ;;
      --pipeline-repo) pipeline_repo="$2"; shift 2 ;;
      --pipeline-repo=*) pipeline_repo="${1#*=}"; shift ;;
      # Already consumed by the top-level pre-scan; accept + drop here so
      # the parser doesn't trip on them.
      --pipeline) shift 2 ;;
      --pipeline=*) shift ;;
      --dry-run) shift ;;
      *) shift ;;
    esac
  done
  if [ -n "$rk" ]; then
    export REGISTRY_KEY="$rk"
    log "provision-and-train: REGISTRY_KEY=$rk PIPELINE=$PIPELINE"
  else
    log "provision-and-train: PIPELINE=$PIPELINE REGISTRY_KEY=$REGISTRY_KEY (env/default)"
  fi
  if [ -n "$epochs" ]; then
    export ELIZA_TRAIN_EPOCHS="$epochs"
    log "provision-and-train: epochs=$epochs (consumed by run_remote via ELIZA_TRAIN_EPOCHS)"
  fi

  # Dry-run short-circuit: print the planned action set and remote
  # command without provisioning. The smoke test and operator preview
  # both rely on this.
  if [ "${DRY_RUN:-0}" = "1" ]; then
    log "[provision-and-train] DRY_RUN=1 — planned actions:"
    log "  1. provision (gpu_target=$VAST_GPU_TARGET, world_size=$FSDP_WORLD_SIZE, image=$VAST_DOCKER_IMAGE, disk=${VAST_DISK_GB}GB)"
    if [ "$bootstrap_mode" = "rsync" ]; then
      log "  2. sync_tree (rsync local training/ → remote $REMOTE_TRAIN_DIR)"
    else
      log "  2. bootstrap_from_hf (pipeline=$pipeline_repo data=$data_repo on remote)"
    fi
    case "$PIPELINE" in
      sft|dpo)
        log "  3. run_remote (accelerate launch train_local.py --registry-key $REGISTRY_KEY --run-name $RUN_NAME)"
        ;;
      grpo)
        local _dpo_default="checkpoints/${REGISTRY_KEY//./-}-dpo/final"
        local _dpo_ckpt="${DPO_CHECKPOINT:-$_dpo_default}"
        # SFT comparison point for the cost-warning string — looked up
        # against the same auto-pick table as the runtime default block.
        local _sft_default
        case "$REGISTRY_KEY" in
          qwen3.5-2b|qwen3.5-9b) _sft_default="blackwell6000-1x" ;;
          qwen3.6-27b)           _sft_default="b200-2x" ;;
          *)                     _sft_default="blackwell6000-2x" ;;
        esac
        log "  3. run_grpo_remote (bash scripts/train_grpo_verl.sh \\"
        log "       --registry-key $REGISTRY_KEY \\"
        log "       --dpo-checkpoint $_dpo_ckpt \\"
        log "       --output-dir checkpoints/$RUN_NAME \\"
        log "       --gpus $FSDP_WORLD_SIZE)"
        log_warn "[provision-and-train] GRPO cost note: $VAST_GPU_TARGET on Vast is meaningfully pricier than the SFT default ($_sft_default)."
        log_warn "[provision-and-train] Per RL_STRATEGY.md: 2B ~24h, 9B ~24-48h, 27B ~48h on H200."
        ;;
    esac
    log "[provision-and-train] dry-run complete — no instance created."
    return 0
  fi

  case "$bootstrap_mode" in
    rsync)
      log "provision-and-train: bootstrap=rsync (default; pushes local training/ tree)"
      provision
      sync_tree
      ;;
    hf)
      log "provision-and-train: bootstrap=hf (pulls pipeline=$pipeline_repo + data=$data_repo on remote)"
      provision
      bootstrap_from_hf --pipeline-repo "$pipeline_repo" --data-repo "$data_repo"
      ;;
    *)
      log_err "provision-and-train: --bootstrap must be 'rsync' or 'hf' (got '$bootstrap_mode')"
      exit 2
      ;;
  esac
  run_for_pipeline
}

bootstrap_from_hf() {
  # Pulls the pipeline + dataset directly onto the remote Vast instance from
  # HuggingFace. Once finished the local box can be powered off — Vast has
  # everything it needs to train.
  local data_repo="elizaos/eliza-1-training"
  local pipeline_repo="elizaos/eliza-1-pipeline"
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --data-repo) data_repo="$2"; shift 2 ;;
      --data-repo=*) data_repo="${1#*=}"; shift ;;
      --pipeline-repo) pipeline_repo="$2"; shift 2 ;;
      --pipeline-repo=*) pipeline_repo="${1#*=}"; shift ;;
      --help|-h)
        cat <<'EOF'
Usage: bash scripts/train_vast.sh bootstrap-from-hf [options]

Pulls the eliza-1 pipeline + training dataset onto the remote Vast instance
directly from HuggingFace. Replaces the local rsync hand-off so a fresh box
can self-bootstrap without your dev machine staying online.

Options:
  --pipeline-repo <id>   HF model repo with the trainer scripts.
                         Default: elizaos/eliza-1-pipeline
  --data-repo <id>       HF dataset repo with train/val/test JSONL.
                         Default: elizaos/eliza-1-training

Requires: VAST_INSTANCE_ID (or .vast_instance_id) and a HuggingFace token
on the remote box (HUGGING_FACE_HUB_TOKEN forwarded via ssh env).
EOF
        return 0
        ;;
      *) shift ;;
    esac
  done
  require_instance_id
  log "bootstrap-from-hf: pipeline=$pipeline_repo data=$data_repo -> $REMOTE_TRAIN_DIR"
  # Forward the local HF token (if any) to the remote box without echoing it.
  # The remote shell reads HF_TOKEN from the environment we open over ssh.
  local hf_token="${HUGGING_FACE_HUB_TOKEN:-${HF_TOKEN:-}}"
  ssh_run "
    set -euo pipefail
    export PATH=\$HOME/.local/bin:\$PATH
    if ! command -v uv >/dev/null 2>&1; then
      curl -LsSf https://astral.sh/uv/install.sh | sh
      export PATH=\$HOME/.local/bin:\$PATH
    fi
    # The current HuggingFace CLI binary is 'hf'. Install hf_transfer for ~5x download
    # parallelism and prefer hf-xet for dataset blob fetches.
    if ! command -v hf >/dev/null 2>&1; then
      python3 -m pip install --user --upgrade 'huggingface_hub[cli,hf_transfer]>=1.0.0' 'hf_xet>=1.0.0'
    fi
    if [ -n '${hf_token}' ]; then
      export HF_TOKEN='${hf_token}'
      export HUGGINGFACE_HUB_TOKEN='${hf_token}'
    fi
    export HF_HUB_ENABLE_HF_TRANSFER=1
    mkdir -p $REMOTE_TRAIN_DIR
    hf download $pipeline_repo --local-dir $REMOTE_TRAIN_DIR
    mkdir -p $REMOTE_TRAIN_DIR/data/final
    hf download $data_repo --repo-type dataset \\
      --local-dir $REMOTE_TRAIN_DIR/data/final \\
      --include 'train.jsonl' --include 'val.jsonl' --include 'test.jsonl' --include 'manifest.json'
    cd $REMOTE_TRAIN_DIR
    uv sync --extra train
    echo '[bootstrap-from-hf] done'
  "
}

status() {
  # Print: instance id, pipeline type, GPU type, uptime, training step,
  # ETA, plus the M9 cost surface (GPU SKU, run-duration, $/hr,
  # total-so-far). Returns exit 0 with a "no instance" message if
  # nothing is provisioned yet — this is what the watcher polls.
  if [ -z "${VAST_INSTANCE_ID:-}" ] && [ -f "$INSTANCE_ID_FILE" ]; then
    VAST_INSTANCE_ID="$(cat "$INSTANCE_ID_FILE")"
    export VAST_INSTANCE_ID
  fi
  if [ -z "${VAST_INSTANCE_ID:-}" ]; then
    log "status: no instance provisioned (no $INSTANCE_ID_FILE, no VAST_INSTANCE_ID)"
    return 0
  fi

  # Pipeline type was persisted at provision time; fall back to the
  # current PIPELINE env if the sidecar is missing (older provisions
  # predated the file).
  local pipeline_type="$PIPELINE"
  if [ -f "$PIPELINE_TYPE_FILE" ]; then
    pipeline_type="$(cat "$PIPELINE_TYPE_FILE")"
  fi
  log "status: instance_id=$VAST_INSTANCE_ID pipeline=$pipeline_type"

  # alive? If the instance has been destroyed, vastai returns nothing useful.
  if ! ( cd "$ROOT" && python3 -m scripts.lib.vast alive "$VAST_INSTANCE_ID" ) >/dev/null 2>&1; then
    log_warn "status: instance $VAST_INSTANCE_ID is NOT alive (destroyed, paused, or unreachable)"
    return 1
  fi

  # Cost surface (M9): pipeline + GPU SKU + run-duration + $/hr + total.
  # vast_budget pulls dph_total via `vastai show instance` and computes
  # total-so-far = dph_total * uptime_hours. The same module is what the
  # watcher invokes for soft/hard-cap enforcement.
  local cost_summary
  cost_summary="$( cd "$ROOT" && \
    REGISTRY_KEY="$REGISTRY_KEY" RUN_NAME="$RUN_NAME" \
    python3 -m scripts.lib.vast_budget snapshot "$VAST_INSTANCE_ID" 2>/dev/null )"
  if [ -n "$cost_summary" ]; then
    log "status: $cost_summary"
  else
    # Fall back to the original GPU+uptime summary if the cost path
    # fails (e.g. vastai returns a partial payload during boot).
    local summary
    summary="$(vastai show instance "$VAST_INSTANCE_ID" --raw 2>/dev/null \
      | python3 -c "
import json, sys, datetime
d=json.load(sys.stdin)
gpu=d.get('gpu_name','?')
ngpu=d.get('num_gpus','?')
status=d.get('actual_status', d.get('cur_state','?'))
start=d.get('start_date') or 0
uptime='?'
try:
    if start:
        uptime=str(datetime.timedelta(seconds=int(__import__('time').time()-float(start))))
except Exception:
    pass
print(f'gpu={gpu}x{ngpu} status={status} uptime={uptime}')
" 2>/dev/null || echo "unavailable")"
    log "status: $summary"
  fi

  # Pull current training step + ETA from instrumentation.jsonl on remote.
  # The training loop appends one JSON object per step. Last line wins.
  # Best-effort — if the remote isn't sshable yet (still loading) we just say so.
  local instr
  instr="$(ssh_run "test -f $REMOTE_TRAIN_DIR/instrumentation.jsonl && tail -n 1 $REMOTE_TRAIN_DIR/instrumentation.jsonl || true" 2>/dev/null || true)"
  if [ -z "$instr" ]; then
    log "status: instrumentation.jsonl not present yet (training may not have started)"
    return 0
  fi
  python3 -c "
import json, sys
try:
    d=json.loads('''$instr''')
except Exception as e:
    print('[train_vast] status: could not parse instrumentation.jsonl tail:', e)
    sys.exit(0)
step=d.get('step') or d.get('global_step')
total=d.get('total_steps') or d.get('max_steps')
loss=d.get('loss')
eta=d.get('eta_seconds') or d.get('eta')
toks_per_s=d.get('tokens_per_second') or d.get('throughput_tokens_s')
parts=[]
if step is not None: parts.append(f'step={step}' + (f'/{total}' if total else ''))
if loss is not None: parts.append(f'loss={loss:.4f}' if isinstance(loss,(int,float)) else f'loss={loss}')
if toks_per_s is not None: parts.append(f'tok/s={toks_per_s}')
if eta is not None:
    try:
        import datetime
        parts.append('eta=' + str(datetime.timedelta(seconds=int(float(eta)))))
    except Exception:
        parts.append(f'eta={eta}')
print('[train_vast] status: ' + (' '.join(parts) if parts else 'no recognizable fields in instrumentation tail'))
"
}

pull_checkpoints() {
  require_instance_id
  local latest_only=0
  for arg in "$@"; do
    case "$arg" in
      --latest-only) latest_only=1 ;;
    esac
  done
  mkdir -p "$ROOT/checkpoints/$RUN_NAME"
  if [ "$latest_only" = "1" ]; then
    # Find the highest-numbered checkpoint-* dir on remote, rsync just that one.
    local latest
    latest="$(ssh_run "ls -d $REMOTE_TRAIN_DIR/checkpoints/$RUN_NAME/checkpoint-* 2>/dev/null | sort -t- -k2 -n | tail -n 1" || true)"
    if [ -z "$latest" ]; then
      log "pull-checkpoints: no checkpoint-* dirs found on remote yet"
      return 0
    fi
    local name
    name="$(basename "$latest")"
    log "pull-checkpoints: latest=$name"
    rsync_remote from "$latest/" "$ROOT/checkpoints/$RUN_NAME/$name/"
  else
    log "pull-checkpoints: pulling all checkpoint-* dirs"
    # Use a trailing slash + --include trickery so rsync only walks
    # checkpoint-* and final/ dirs, skipping intermediate scratch.
    rsync_remote from "$REMOTE_TRAIN_DIR/checkpoints/$RUN_NAME/" \
      "$ROOT/checkpoints/$RUN_NAME/" \
      --include='checkpoint-*/' --include='checkpoint-*/**' \
      --include='final/' --include='final/**' \
      --exclude='*' || true
  fi
}

tail_logs() {
  require_instance_id
  log "tail-logs: streaming /workspace/train.log (Ctrl-C to stop)"
  # tail -F follows file rotation; -n 200 dumps the last chunk so the
  # operator sees recent context immediately.
  ssh_run "tail -F -n 200 /workspace/train.log 2>/dev/null || tail -F -n 200 $REMOTE_TRAIN_DIR/train.log"
}

kill_and_teardown() {
  require_instance_id
  local confirmed=0
  for arg in "$@"; do
    case "$arg" in
      --yes|--force|-y) confirmed=1 ;;
    esac
  done
  if [ "${CONFIRM_TEARDOWN:-0}" = "1" ]; then
    confirmed=1
  fi
  if [ "$confirmed" -ne 1 ]; then
    log_err "kill-and-teardown: refusing to destroy instance $VAST_INSTANCE_ID without --yes"
    exit 2
  fi
  log "kill-and-teardown: SIGTERM training process on $VAST_INSTANCE_ID"
  # accelerate / torchrun spawn the actual workers for SFT/DPO; verl's
  # main_ppo spawns Ray workers + vLLM rollout pods for GRPO. pkill -f
  # on the launcher cleans up the children. Best-effort; we don't fail
  # the teardown if the ssh attempt errors (instance may already be
  # unreachable).
  ssh_run "pkill -TERM -f 'accelerate launch' || true
           pkill -TERM -f train_local.py || true
           pkill -TERM -f train_grpo_verl || true
           pkill -TERM -f 'verl.trainer.main_ppo' || true" || true
  log "kill-and-teardown: waiting 60s for graceful shutdown"
  sleep 60
  log "kill-and-teardown: hard-kill any remaining workers"
  ssh_run "pkill -KILL -f 'accelerate launch' || true
           pkill -KILL -f train_local.py || true
           pkill -KILL -f train_grpo_verl || true
           pkill -KILL -f 'verl.trainer.main_ppo' || true" || true
  log "kill-and-teardown: destroying instance"
  vastai destroy instance "$VAST_INSTANCE_ID"
  rm -f "$INSTANCE_ID_FILE" "$PIPELINE_TYPE_FILE"
}

print_help() {
  cat <<'EOF'
[train_vast] Vast.ai is the canonical (and only active) cloud for eliza-1
[train_vast] training and inference. Nebius is deprecated.

Global flags (recognized at any position, also captured into PIPELINE env):
  --pipeline sft|dpo|grpo                      Default: sft. Selects training stage.
                                               grpo allocates h200-{2,4,8}x (or b200
                                               fallback) and runs train_grpo_verl.sh.
  --registry-key K                             Override REGISTRY_KEY (e.g. qwen3.5-9b)
  --dry-run                                    Print the planned GPU SKU + remote
                                               command and exit (no Vast spend).

Subcommands:
  search                                       List matching offers (read-only)
  provision                                    Spin up a Vast.ai instance
  sync                                         rsync training/ to instance
  run                                          Launch the configured pipeline (remote):
                                                 sft|dpo → accelerate launch + APOLLO
                                                 grpo    → bash train_grpo_verl.sh
  quantize                                     Apply QUANTIZE_AFTER list (remote, SFT only)
  bench                                        Run eliza_bench on base + finetuned
  fetch                                        rsync checkpoints + benchmarks back
  full                                         provision -> sync -> run [-> quantize -> bench
                                               only for SFT] -> fetch

  provision-and-train --registry-key K --epochs N [--bootstrap rsync|hf] [--pipeline P] [--dry-run]
                                               Provision + sync (or HF download) + run in one shot
  bootstrap-from-hf [--pipeline-repo R] [--data-repo R]
                                               Remote: pull pipeline + dataset from HF (no local rsync)
  status                                       Print instance id, pipeline type, GPU, uptime, step, ETA
  pull-checkpoints [--latest-only]             rsync checkpoint-* dirs back. With
                                               --latest-only, only the highest step.
  tail-logs                                    Stream remote training stdout/stderr
  kill-and-teardown --yes                      Graceful SIGTERM (accelerate + verl), wait 60s, then destroy

  teardown --yes                               Destroy the instance immediately
  help                                         Show this message

GRPO-specific env vars (apply when --pipeline grpo):
  DPO_CHECKPOINT                Path to the SFT+DPO checkpoint's final/ dir on
                                the remote box. Default:
                                checkpoints/<reg-key>-dpo/final
  GRPO_ROLLOUTS                 verl `actor_rollout_ref.rollout.n` (default 8).
  GRPO_ROLLOUT_BATCH            Prompts per rollout step (default 8).
  GRPO_EPOCHS                   PPO/GRPO epochs over the rollout buffer (default 1).
  GRPO_MAX_RESPONSE_LEN         Max generated tokens per rollout (default 1024).

Standardized env vars:
  VAST_API_KEY                  vastai API key
  ELIZA_VAST_GPU_PREFERENCE    csv: B200,H200,H100,RTX5090
  ELIZA_VAST_DISK_GB           default 200; aliases VAST_DISK_GB
  ELIZA_VAST_INSTANCE_ID       set after provision; aliases VAST_INSTANCE_ID

Refuses to run when any NEBIUS_* env var is set.
EOF
}

case "$cmd" in
  search) search_offers ;;
  provision) provision ;;
  sync) sync_tree ;;
  run) run_for_pipeline ;;
  quantize) quantize_remote ;;
  bench) bench_remote ;;
  fetch) fetch ;;
  teardown) teardown "${SUBCMD_ARGS[@]+"${SUBCMD_ARGS[@]}"}" ;;
  provision-and-train) provision_and_train "${SUBCMD_ARGS[@]+"${SUBCMD_ARGS[@]}"}" ;;
  bootstrap-from-hf) bootstrap_from_hf "${SUBCMD_ARGS[@]+"${SUBCMD_ARGS[@]}"}" ;;
  status) status ;;
  pull-checkpoints) pull_checkpoints "${SUBCMD_ARGS[@]+"${SUBCMD_ARGS[@]}"}" ;;
  tail-logs) tail_logs ;;
  kill-and-teardown) kill_and_teardown "${SUBCMD_ARGS[@]+"${SUBCMD_ARGS[@]}"}" ;;
  full)
    provision
    sync_tree
    run_for_pipeline
    # Quantization + benchmarking still only make sense for the SFT
    # pipeline (the GRPO output is RL-tuned but the same arch; we
    # quantize the SFT base, not the GRPO actor). Skip them when the
    # operator drove a non-SFT pipeline through `full`.
    if [ "$PIPELINE" = "sft" ]; then
      quantize_remote
      bench_remote
    else
      log "[full] PIPELINE=$PIPELINE — skipping quantize + bench (SFT-only)"
    fi
    fetch
    ;;
  help|--help|-h) print_help ;;
  *) print_help; exit 2 ;;
esac
