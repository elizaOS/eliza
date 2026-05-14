#!/usr/bin/env bash
# =============================================================================
# Multi-tier Nebius H200 smoke driver for the full eliza-1 fused-model line.
#
# Pipeline-validation companion to scripts/train_nebius.sh. Where train_nebius.sh
# `full` provisions+trains+fetches+tears-down ONE tier per VM lifecycle, this
# driver loops over EVERY eliza-1 tier on a SINGLE VM lifecycle (~$30-40 on H200
# at ~10h end-to-end) so a single billing window validates the full
# 0.8B → 27B-1m chain on a small smoke corpus.
#
# CONTROL FLOW (5 lines, matches the EXIT-trap pattern at line 615 of train_nebius.sh):
#   1) provision (or reuse) ONE Nebius H200 VM
#   2) sync packages/training/ + the smoke corpus once (incremental rsync)
#   3) for each tier in $TIERS: launch run_pipeline.py --max-steps=$SMOKE_MAX_STEPS,
#        stream log via tail-loop, on completion fetch per-tier ckpt + benchmarks
#        + reports back to local. A failing tier is logged and the loop CONTINUES
#        (smoke is pipeline validation — one tier failing must not block the rest).
#   4) EXIT trap fires UNCONDITIONALLY: best-effort fetch any remaining tier, then
#        teardown VM + boot disk. Fires on Ctrl-C/kill/unexpected exit too.
#   5) The trap calls teardown ONLY when REUSE_EXISTING_VM != 1 — if the operator
#        opted to reuse a pre-existing user-owned VM (e.g. eliza-train-h200-main),
#        we never delete it; we only fetch.
#
# Env vars:
#   NEBIUS_PROJECT_ID            REQUIRED (same as train_nebius.sh).
#   NEBIUS_VM_NAME               default eliza-train-h200-smoke-all. Set to
#                                  eliza-train-h200-main to reuse the
#                                  user-persistent VM (combine with REUSE_EXISTING_VM=1).
#   REUSE_EXISTING_VM            1 = if a VM named $NEBIUS_VM_NAME already exists,
#                                  reuse it (skip create); EXIT trap will SKIP teardown.
#                                  0 = always provision a fresh VM, EXIT trap tears down.
#                                  Default: 1 if a VM with that name exists, else 0
#                                  (auto-detected at startup, snapshotted into
#                                  REUSE_EXISTING_VM for the EXIT trap).
#   TIERS                        space-separated tier list. Default:
#                                  "0_8b 2b 4b 9b 27b 27b-256k 27b-1m"
#                                  Each token maps to a registry key + optional
#                                  --max-seq-len override:
#                                    0_8b      → qwen3.5-0.8b   (registry seq_len)
#                                    2b        → qwen3.5-2b
#                                    4b        → qwen3.5-4b
#                                    9b        → qwen3.5-9b
#                                    27b       → qwen3.6-27b
#                                    27b-256k  → qwen3.6-27b   --max-seq-len 262144
#                                    27b-1m    → qwen3.6-27b   --max-seq-len 1048576
#                                  Use a smaller list to test a subset:
#                                    TIERS="0_8b 2b" bash ... smoke-all
#   SMOKE_MAX_STEPS              hard step cap per tier. Default 50 (smoke).
#                                  Set 0 to use --epochs 1 (real run).
#   SMOKE_DATA_DIR               relative to packages/training/. Default
#                                  data/final-eliza1-smoke. SMOKE-CORPUS-BUILDER
#                                  is responsible for producing
#                                    $SMOKE_DATA_DIR/{train,val,test}.jsonl
#                                  (~10 records each is enough — this is a
#                                  pipeline smoke, not a quality run).
#   HUGGING_FACE_HUB_TOKEN       for gated Qwen access (forwarded to remote).
#   ELIZA_SMOKE_RUN_TAG          stem for per-tier run names. Default
#                                  "smoke-all-$(date +%s)". Final run name per
#                                  tier is "<eliza-public-name>-<tag>-<tier>".
#   ELIZA_SMOKE_FETCH_ONLY       1 = skip launching; only fetch artifacts from
#                                  the remote (recovery path). Default 0.
#   ELIZA_SMOKE_CONTINUE_ON_FAIL 0 = stop the tier loop on the first failure.
#                                  Default 1 = continue (smoke philosophy).
#
# Usage:
#   bash scripts/train_nebius_smoke_all_tiers.sh smoke-all
#   bash scripts/train_nebius_smoke_all_tiers.sh teardown        # one-shot teardown
#   bash scripts/train_nebius_smoke_all_tiers.sh fetch <tier>    # one tier's ckpts
#
# EXIT-trap correctness:
#   The trap is `_smoke_all_exit_trap`, registered before the tier loop starts.
#   On *any* exit path (clean, error, Ctrl-C, SIGTERM, set -e abort):
#     - if REUSE_EXISTING_VM=1: skip teardown — VM is user-owned.
#     - else: best-effort fetch any tier still on the remote, then run
#       `train_nebius.sh teardown` (which deletes VM + boot disk via the same
#       _id_by_name helpers train_nebius.sh uses). teardown errors are logged
#       but do NOT abort the trap so the second resource (boot disk) is still
#       attempted after a failed instance delete. This is the same pattern as
#       train_nebius.sh's `full` trap at line 615.
# =============================================================================

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NEBIUS_SCRIPT="$ROOT/scripts/train_nebius.sh"

: "${NEBIUS_PROJECT_ID:?must export NEBIUS_PROJECT_ID}"
: "${NEBIUS_VM_NAME:=eliza-train-h200-smoke-all}"
: "${TIERS:=0_8b 2b 4b 9b 27b 27b-256k 27b-1m}"
: "${SMOKE_MAX_STEPS:=50}"
: "${SMOKE_DATA_DIR:=data/final-eliza1-smoke}"
: "${ELIZA_SMOKE_RUN_TAG:=smoke-all-$(date +%s)}"
: "${ELIZA_SMOKE_FETCH_ONLY:=0}"
: "${ELIZA_SMOKE_CONTINUE_ON_FAIL:=1}"

# Auto-detect VM reuse: if user did not override REUSE_EXISTING_VM and the named
# VM already exists in the project, default to reuse + skip-teardown. Otherwise
# default to provision-and-teardown lifecycle.
export NEBIUS_VM_NAME
if [ -z "${REUSE_EXISTING_VM:-}" ]; then
  if bash "$NEBIUS_SCRIPT" ip >/dev/null 2>&1; then
    REUSE_EXISTING_VM=1
    echo "[smoke-all] auto-detected existing VM $NEBIUS_VM_NAME — reuse mode (EXIT trap will SKIP teardown)"
  else
    REUSE_EXISTING_VM=0
    echo "[smoke-all] no existing VM $NEBIUS_VM_NAME — provision-and-teardown mode"
  fi
fi
export REUSE_EXISTING_VM

# Per-tier knobs. Format: <token> <registry-key> <extra-args ...>
# Looked up by `_tier_args <token>` (echoes "registry-key extra-args" or empty
# string + nonzero rc if unknown). Keep this list and the env-var doc above in
# sync with packages/training/scripts/training/model_registry.py.
_tier_args() {
  case "$1" in
    0_8b)     echo "qwen3.5-0.8b" ;;
    2b)       echo "qwen3.5-2b" ;;
    4b)       echo "qwen3.5-4b" ;;
    9b)       echo "qwen3.5-9b" ;;
    27b)      echo "qwen3.6-27b" ;;
    27b-256k) echo "qwen3.6-27b --max-seq-len 262144" ;;
    27b-1m)   echo "qwen3.6-27b --max-seq-len 1048576" ;;
    *) return 1 ;;
  esac
}

# --- VM helpers (delegates to train_nebius.sh for SSH plumbing) -------------

_vm_ip() {
  NEBIUS_VM_NAME="$NEBIUS_VM_NAME" bash "$NEBIUS_SCRIPT" ip 2>/dev/null || true
}

_ssh_target() {
  local ip; ip="$(_vm_ip)"
  [ -n "$ip" ] || { echo "[smoke-all] no IP for $NEBIUS_VM_NAME" >&2; return 1; }
  echo "ubuntu@$ip"
}

# Run a one-off remote command on the VM. Used for log-tail + run-readiness
# probes that don't need the heavyweight train_nebius.sh sync/run wrappers.
_remote() {
  local target; target="$(_ssh_target)" || return 1
  ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 "$target" "$@"
}

# --- per-tier launch / poll / fetch -----------------------------------------

_tier_run_name() {
  # Tier-stable, tag-scoped run name. Eliza public name comes from the registry
  # lookup so 27b/27b-256k/27b-1m don't collide (all map to qwen3.6-27b).
  local tier="$1" pub="$2"
  echo "${pub}-${ELIZA_SMOKE_RUN_TAG}-${tier}"
}

# Launch run_pipeline.py on the remote for one tier. Writes the runner script
# to /opt/training/.smoke_<tier>.sh, starts tmux session 'elizasmoke_<tier>',
# polls log for the canonical RUN_PIPELINE_EXIT sentinel, returns 0 on
# rc=0 and 1 otherwise.
_launch_one_tier() {
  local tier="$1"
  local spec rk extra hf_tok log script_path
  spec="$(_tier_args "$tier")" || { echo "[smoke-all][$tier] unknown tier — skipping" >&2; return 2; }
  rk="$(echo "$spec" | awk '{print $1}')"
  extra="$(echo "$spec" | cut -d' ' -f2-)"
  [ "$extra" = "$rk" ] && extra=""

  # Resolve the eliza public name via the local registry so the per-tier run
  # name doesn't collide across the three 27B variants.
  local pub
  pub="$(cd "$ROOT" && python3 -c "
import sys, pathlib
sys.path.insert(0, str(pathlib.Path('scripts').resolve()))
from training.model_registry import get
e = get('$rk')
print(e.public_name)
" 2>/dev/null)"
  [ -n "$pub" ] || pub="$rk"

  local run_name; run_name="$(_tier_run_name "$tier" "$pub")"
  local target; target="$(_ssh_target)" || return 1
  hf_tok="${HUGGING_FACE_HUB_TOKEN:-${HF_TOKEN:-}}"
  log="/opt/training/run_${run_name}.log"
  script_path="/opt/training/.smoke_${tier}.sh"
  local sess="elizasmoke_${tier//-/_}"

  local max_steps_flag=""
  [ "${SMOKE_MAX_STEPS:-0}" -gt 0 ] 2>/dev/null && max_steps_flag="--max-steps ${SMOKE_MAX_STEPS}"

  echo "[smoke-all][$tier] launch: registry=$rk run=$run_name max_steps=${SMOKE_MAX_STEPS:-0} extra='$extra'"

  ssh -o StrictHostKeyChecking=no "$target" "cat > $script_path" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd /opt/training
export PATH=\$HOME/.local/bin:\$PATH
export CUDA_VISIBLE_DEVICES=0
export ELIZA_NO_DEVICE_MAP=1
export HF_HOME=/opt/hf-cache
sudo mkdir -p \$HF_HOME && sudo chown -R \$USER \$HF_HOME || true
${hf_tok:+export HUGGING_FACE_HUB_TOKEN='$hf_tok'; export HF_TOKEN='$hf_tok'}

# Same cu130→cu128 torch swap as train_nebius.sh — the Nebius cuda12.8 image
# ships driver 570.x which can't see cu130 torch. Skip if a previous tier on
# this VM already swapped (UV_NO_SYNC=1 stays sticky in the venv, but we
# re-probe defensively).
torch_swap_cu128() {
  .venv/bin/python -c 'import torch,sys; sys.exit(0 if torch.cuda.is_available() else 1)' 2>/dev/null && return 0
  uv pip uninstall --python .venv/bin/python torch torchvision triton 2>/dev/null || true
  cu13pkgs="\$(uv pip list --python .venv/bin/python 2>/dev/null | awk '/^nvidia-[a-z0-9-]+ /{print \$1}')"
  [ -n "\$cu13pkgs" ] && uv pip uninstall --python .venv/bin/python \$cu13pkgs 2>/dev/null || true
  uv pip install --python .venv/bin/python 'torch==2.11.0' --index-url https://download.pytorch.org/whl/cu128
  uv pip install --python .venv/bin/python --reinstall nvidia-cusparselt-cu12
}
if [ ! -d .venv ]; then
  uv sync --extra train
fi
torch_swap_cu128
export UV_NO_SYNC=1 UV_FROZEN=1

uv run --extra train python scripts/run_pipeline.py \\
  --registry-key $rk --run-name $run_name \\
  --epochs 1 --lr 1e-5 --use-liger on \\
  $max_steps_flag $extra \\
  --train-file ${SMOKE_DATA_DIR}/train.jsonl \\
  --val-file ${SMOKE_DATA_DIR}/val.jsonl \\
  --test-file ${SMOKE_DATA_DIR}/test.jsonl \\
  --eval-mode smoke --bench-per-bucket 50 --skip-throughput-bench \\
  --quantizers polarquant --skip-base-bench --skip-publish --allow-unvalidated-corpus
echo RUN_PIPELINE_DONE_OK
EOF

  ssh -o StrictHostKeyChecking=no "$target" "chmod +x $script_path; tmux kill-session -t $sess 2>/dev/null || true; tmux new-session -d -s $sess \"bash $script_path 2>&1 | tee $log; echo RUN_PIPELINE_EXIT=\\\${PIPESTATUS[0]} >> $log\""

  # Poll the log every 60s. Re-uses the same RUN_PIPELINE_EXIT sentinel format
  # that train_nebius.sh:run_remote emits, so nebius_watcher.sh continues to
  # match line-anchored without changes.
  local i=0
  local per_tier_budget_min="${ELIZA_SMOKE_PER_TIER_TIMEOUT_MIN:-180}"
  while true; do
    sleep 60; i=$((i+1))
    local tail_out
    tail_out="$(_remote "tail -n 3 $log 2>/dev/null" 2>/dev/null || echo '(ssh hiccup)')"
    echo "[smoke-all][$tier] +${i}m | $(echo "$tail_out" | tr '\n' ' ' | tr '\r' ' ' | tail -c 200)"
    if _remote "grep -qE '^RUN_PIPELINE_EXIT=[0-9]' $log 2>/dev/null"; then
      local rc
      rc="$(_remote "grep -E '^RUN_PIPELINE_EXIT=' $log | tail -1 | sed 's/.*=//'" 2>/dev/null || echo '?')"
      echo "[smoke-all][$tier] pipeline finished (RUN_PIPELINE_EXIT=$rc)"
      [ "$rc" = "0" ] || return 1
      return 0
    fi
    if [ "$i" -gt "$per_tier_budget_min" ]; then
      echo "[smoke-all][$tier] ERROR: tier still running after ${per_tier_budget_min}m — sending C-c and moving on"
      _remote "tmux send-keys -t $sess C-c 2>/dev/null || true" || true
      return 1
    fi
  done
}

_fetch_one_tier() {
  local tier="$1"
  local spec rk pub run_name target
  spec="$(_tier_args "$tier")" || return 2
  rk="$(echo "$spec" | awk '{print $1}')"
  pub="$(cd "$ROOT" && python3 -c "
import sys, pathlib
sys.path.insert(0, str(pathlib.Path('scripts').resolve()))
from training.model_registry import get
print(get('$rk').public_name)
" 2>/dev/null)"
  [ -n "$pub" ] || pub="$rk"
  run_name="$(_tier_run_name "$tier" "$pub")"
  target="$(_ssh_target)" || return 1

  echo "[smoke-all][$tier] fetch run=$run_name"
  mkdir -p "$ROOT/checkpoints/$run_name" "$ROOT/benchmarks/$run_name" "$ROOT/reports"
  rsync -avhz --info=progress2 "$target:/opt/training/checkpoints/$run_name/" "$ROOT/checkpoints/$run_name/" || true
  rsync -avhz --info=progress2 "$target:/opt/training/benchmarks/$run_name/" "$ROOT/benchmarks/$run_name/" || true
  rsync -avhz --info=progress2 "$target:/opt/training/reports/" "$ROOT/reports/" || true
}

# --- EXIT trap: fetch-then-teardown (unless VM is user-owned) ---------------

_FETCHED_TIERS=""
_smoke_all_exit_trap() {
  local rc=$?
  echo "[smoke-all] EXIT trap fired (rc=$rc) — best-effort fetch + teardown"
  # Best-effort fetch any tier that didn't complete the in-loop fetch (e.g.
  # Ctrl-C mid-launch). Tier loop sets _FETCHED_TIERS as it goes, so we only
  # re-fetch the stragglers.
  for tier in $TIERS; do
    case " $_FETCHED_TIERS " in
      *" $tier "*) ;;
      *) _fetch_one_tier "$tier" || true ;;
    esac
  done
  if [ "${REUSE_EXISTING_VM:-0}" = "1" ]; then
    echo "[smoke-all] REUSE_EXISTING_VM=1 — leaving $NEBIUS_VM_NAME up (user-owned)"
  else
    echo "[smoke-all] tearing down $NEBIUS_VM_NAME"
    NEBIUS_VM_NAME="$NEBIUS_VM_NAME" bash "$NEBIUS_SCRIPT" teardown || \
      echo "[smoke-all] WARN: teardown failed — check 'nebius compute v1 instance list --parent-id $NEBIUS_PROJECT_ID'"
  fi
}

# --- top-level subcommands --------------------------------------------------

smoke_all() {
  # Arm the trap BEFORE provisioning so a failure during provision still tries
  # to tear down (matches train_nebius.sh's `full` invariant).
  trap _smoke_all_exit_trap EXIT

  if [ "$ELIZA_SMOKE_FETCH_ONLY" = "1" ]; then
    echo "[smoke-all] ELIZA_SMOKE_FETCH_ONLY=1 — skipping launch, only fetching"
    for tier in $TIERS; do
      _fetch_one_tier "$tier" || echo "[smoke-all][$tier] fetch failed (continuing)"
      _FETCHED_TIERS="$_FETCHED_TIERS $tier"
    done
    return 0
  fi

  if [ "$REUSE_EXISTING_VM" = "1" ]; then
    echo "[smoke-all] reusing existing VM $NEBIUS_VM_NAME"
  else
    echo "[smoke-all] provisioning fresh VM $NEBIUS_VM_NAME"
    NEBIUS_VM_NAME="$NEBIUS_VM_NAME" bash "$NEBIUS_SCRIPT" provision
  fi

  echo "[smoke-all] syncing training tree + smoke corpus"
  # Reuse train_nebius.sh sync; it incremental-rsyncs the slim scripts tree.
  # Then send the smoke corpus over (it lives outside the default data/final
  # path, so the main sync excludes it — explicit rsync follows).
  TRAIN_FILE="$SMOKE_DATA_DIR/train.jsonl" \
  VAL_FILE="$SMOKE_DATA_DIR/val.jsonl" \
  TEST_FILE="$SMOKE_DATA_DIR/test.jsonl" \
    NEBIUS_VM_NAME="$NEBIUS_VM_NAME" bash "$NEBIUS_SCRIPT" sync

  local target; target="$(_ssh_target)"
  ssh -o StrictHostKeyChecking=no "$target" "mkdir -p /opt/training/$SMOKE_DATA_DIR"
  rsync -avhz --partial "$ROOT/$SMOKE_DATA_DIR/" "$target:/opt/training/$SMOKE_DATA_DIR/" || \
    { echo "[smoke-all] FATAL: smoke corpus rsync failed (is $ROOT/$SMOKE_DATA_DIR/ populated by SMOKE-CORPUS-BUILDER?)" >&2; exit 1; }

  local tier rc
  for tier in $TIERS; do
    echo "[smoke-all] === tier $tier ==="
    rc=0
    _launch_one_tier "$tier" || rc=$?
    _fetch_one_tier "$tier" || echo "[smoke-all][$tier] fetch failed (continuing)"
    _FETCHED_TIERS="$_FETCHED_TIERS $tier"
    if [ "$rc" -ne 0 ]; then
      echo "[smoke-all][$tier] FAILED (rc=$rc)"
      if [ "$ELIZA_SMOKE_CONTINUE_ON_FAIL" = "1" ]; then
        echo "[smoke-all][$tier] ELIZA_SMOKE_CONTINUE_ON_FAIL=1 — moving to next tier"
        continue
      else
        echo "[smoke-all][$tier] ELIZA_SMOKE_CONTINUE_ON_FAIL=0 — aborting"
        return "$rc"
      fi
    fi
    echo "[smoke-all][$tier] OK"
  done

  echo "[smoke-all] MULTI_TIER_DONE tiers=$TIERS tag=$ELIZA_SMOKE_RUN_TAG"
}

# --- entrypoints ------------------------------------------------------------

cmd="${1:-help}"
case "$cmd" in
  smoke-all) smoke_all ;;
  fetch)
    tier="${2:?fetch needs a tier token (e.g. 0_8b)}"
    _fetch_one_tier "$tier"
    ;;
  teardown)
    # One-shot teardown — delegates straight to train_nebius.sh.
    NEBIUS_VM_NAME="$NEBIUS_VM_NAME" bash "$NEBIUS_SCRIPT" teardown
    ;;
  ip)
    _vm_ip
    ;;
  help|*) sed -n '1,110p' "$0" ;;
esac
