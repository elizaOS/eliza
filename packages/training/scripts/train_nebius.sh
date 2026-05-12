#!/usr/bin/env bash
# =============================================================================
# DEPRECATED 2026-05-04. Vast.ai is the canonical cloud (see
# scripts/train_vast.sh). This script kept for emergency fallback. Do not
# extend, do not document Nebius as an option in user-facing material, do not
# add new commands or flags. Bug fixes only.
# =============================================================================
#
# Provision a Nebius H200 instance, sync the training tree, and run a
# full-parameter SFT with APOLLO on a Qwen3.5/3.6 model that's too big to
# train on the local 16GB GPU.
#
# eliza-1 cloud-tier targets (model_registry.py):
#   REGISTRY_KEY=qwen3.5-9b   → eliza-1-9b   (single H200 SXM, ~80 GB peak)
#   REGISTRY_KEY=qwen3.6-27b  → eliza-1-27b  (2× H200 SXM, FSDP, 144k context)
# The 2× H200 default below sizes for the 27B; switch NEBIUS_VM_PRESET to
# gpu-h200x1 when training the 9B to halve the bill.
#
# Override via REGISTRY_KEY env var. The model registry drives
# micro_batch / grad_accum / seq_len.
#
# After training, the script optionally runs PolarQuant + TurboQuant on the
# resulting checkpoint and the native function-calling benchmark for base-vs-finetuned
# comparison numbers.
#
# Required env:
#   NEBIUS_PROJECT_ID
#   HUGGING_FACE_HUB_TOKEN     # for gated Qwen access
# Optional env:
#   REGISTRY_KEY               # default: qwen3.6-27b
#   RUN_NAME                   # default: <registry-key>-apollo
#   NEBIUS_VM_PRESET           # default: gpu-h200x1
#   NEBIUS_VM_REGION           # default: eu-north1
#   QUANTIZE_AFTER             # comma-separated; default: polarquant,turboquant
#   BENCHMARK_AFTER            # 1 = run native benchmark base+finetuned (default 1)
#
# Usage:
#   bash scripts/train_nebius.sh provision   # spin up the VM
#   bash scripts/train_nebius.sh sync        # rsync training/ to VM
#   bash scripts/train_nebius.sh run         # remote: launch training
#   bash scripts/train_nebius.sh quantize    # remote: PolarQuant + TurboQuant
#   bash scripts/train_nebius.sh bench       # remote: base + fine-tuned bench
#   bash scripts/train_nebius.sh fetch       # rsync checkpoints + benchmarks back
#   bash scripts/train_nebius.sh teardown    # delete the VM
#
# Or `bash scripts/train_nebius.sh full` for the whole flow.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

: "${NEBIUS_PROJECT_ID:?must export NEBIUS_PROJECT_ID}"
: "${NEBIUS_VM_NAME:=eliza-train-h200}"
: "${NEBIUS_VM_PRESET:=gpu-h200x2}"
: "${NEBIUS_VM_REGION:=eu-north1}"
: "${NEBIUS_VM_DISK_GB:=2048}"
: "${NEBIUS_SSH_USER:=ubuntu}"

REMOTE_TRAIN_DIR="/opt/training"
REGISTRY_KEY="${REGISTRY_KEY:-qwen3.6-27b}"
RUN_NAME="${RUN_NAME:-${REGISTRY_KEY//./-}-apollo}"
QUANTIZE_AFTER="${QUANTIZE_AFTER:-polarquant,fused_turboquant,qjl}"
BENCHMARK_AFTER="${BENCHMARK_AFTER:-1}"
PUSH_AFTER="${PUSH_AFTER:-0}"
SYNC_FULLCORPUS_SOURCES="${SYNC_FULLCORPUS_SOURCES:-0}"

TRAIN_FILE="${TRAIN_FILE:-data/final/train.jsonl}"
VAL_FILE="${VAL_FILE:-data/final/val.jsonl}"
TEST_FILE="${TEST_FILE:-data/final/test.jsonl}"

# NEBIUS_VM_PRESET → (platform, preset, default world size). The H200 platform
# (`gpu-h200-sxm`) has no 2-GPU preset; the only multi-GPU preset is 8×.
case "$NEBIUS_VM_PRESET" in
  gpu-h200x1) NEBIUS_PLATFORM="gpu-h200-sxm";  NEBIUS_PRESET="1gpu-16vcpu-200gb";    DEFAULT_WORLD=1 ;;
  gpu-h200x2) NEBIUS_PLATFORM="gpu-h200-sxm";  NEBIUS_PRESET="8gpu-128vcpu-1600gb";  DEFAULT_WORLD=8 ;;
  *) echo "[train_nebius] unknown NEBIUS_VM_PRESET '$NEBIUS_VM_PRESET' (gpu-h200x1|gpu-h200x2)" >&2; exit 2 ;;
esac
FSDP_WORLD_SIZE="${FSDP_WORLD_SIZE:-$DEFAULT_WORLD}"

# The transformer decoder-layer class FSDP wraps. Every entry in the
# Qwen3.5-only model registry (qwen3.5-0.8b/2b/4b/9b/27b + qwen3.6-27b
# legacy) uses Qwen3_5DecoderLayer; the legacy Qwen3 dense bases (which
# would have used Qwen3DecoderLayer) were dropped on 2026-05-12.
FSDP_WRAP_CLS="Qwen3_5DecoderLayer"

cmd="${1:-help}"

vm_ip() {
  nebius compute v1 instance get \
    --id "$NEBIUS_VM_NAME" \
    --format json 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['status']['network_interfaces'][0]['public_ip_address']['address'])"
}

ssh_target() {
  echo "$NEBIUS_SSH_USER@$(vm_ip)"
}

provision() {
  echo "[provision] creating VM $NEBIUS_VM_NAME ($NEBIUS_VM_PRESET, $NEBIUS_VM_REGION)"
  nebius compute v1 instance create \
    --project-id "$NEBIUS_PROJECT_ID" \
    --name "$NEBIUS_VM_NAME" \
    --resources-preset "$NEBIUS_VM_PRESET" \
    --boot-disk-spec '{"size_bytes":'"$((NEBIUS_VM_DISK_GB * 1024 * 1024 * 1024))"',"image":"cuda12-ubuntu24.04"}' \
    --network-interfaces '[{"subnet_id":"default","public_ip_address":{}}]' \
    --metadata "{\"ssh-keys\":\"$NEBIUS_SSH_USER:$(cat ~/.ssh/id_ed25519.pub)\"}"
  echo "[provision] waiting for ssh"
  for _ in $(seq 1 60); do
    if ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 "$(ssh_target)" "echo ok" 2>/dev/null; then
      break
    fi
    sleep 5
  done
  echo "[provision] installing system deps"
  ssh -o StrictHostKeyChecking=no "$(ssh_target)" \
    'sudo apt-get update -y && sudo apt-get install -y rsync git tmux jq && curl -LsSf https://astral.sh/uv/install.sh | sh'
}

sync_tree() {
  local target
  target="$(ssh_target)"
  echo "[sync] rsyncing training/ to $target:$REMOTE_TRAIN_DIR"
  ssh -o StrictHostKeyChecking=no "$target" \
    "sudo mkdir -p $REMOTE_TRAIN_DIR && sudo chown -R \$USER $REMOTE_TRAIN_DIR"
  rsync -avh --delete \
    --exclude '.venv/' --exclude 'data/raw/' --exclude 'checkpoints/' --exclude 'wandb/' \
    "$ROOT/" "$target:$REMOTE_TRAIN_DIR/"
  echo "[sync] sending data/final/"
  rsync -avh --partial --info=progress2 \
    "$ROOT/data/final/" "$target:$REMOTE_TRAIN_DIR/data/final/"
}

run_remote() {
  local target
  target="$(ssh_target)"
  echo "[run] launching APOLLO full-finetune on $target (registry=$REGISTRY_KEY run=$RUN_NAME)"
  ssh -o StrictHostKeyChecking=no "$target" "bash -lc '
    set -euo pipefail
    cd $REMOTE_TRAIN_DIR
    export PATH=\$HOME/.local/bin:\$PATH
    uv sync --extra train
    export HF_HOME=/opt/hf-cache
    sudo mkdir -p \$HF_HOME && sudo chown -R \$USER \$HF_HOME
    if [ -n \"\${HUGGING_FACE_HUB_TOKEN:-}\" ]; then
      uv run hf auth login --token \"\$HUGGING_FACE_HUB_TOKEN\"
    fi
    uv run --extra train accelerate launch \\
      --num_processes $FSDP_WORLD_SIZE \\
      --mixed_precision bf16 \\
      --use_fsdp \\
      --fsdp_sharding_strategy FULL_SHARD \\
      --fsdp_state_dict_type SHARDED_STATE_DICT \\
      --fsdp_offload_params false \\
      --fsdp_cpu_ram_efficient_loading true \\
      --fsdp_backward_prefetch BACKWARD_PRE \\
      scripts/train_local.py \\
        --registry-key $REGISTRY_KEY \\
        --run-name $RUN_NAME \\
        --epochs 1 \\
        --lr 1e-5 \\
        --full-finetune \\
        --use-liger on
  '"
}

quantize_remote() {
  local target
  target="$(ssh_target)"
  echo "[quantize] running $QUANTIZE_AFTER on $target"
  IFS=',' read -ra qs <<< "$QUANTIZE_AFTER"
  for q in "${qs[@]}"; do
    echo "  → $q"
    ssh -o StrictHostKeyChecking=no "$target" "bash -lc '
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
  local target
  target="$(ssh_target)"
  if [ "$BENCHMARK_AFTER" != "1" ]; then
    echo "[bench] BENCHMARK_AFTER=0 — skipping"
    return 0
  fi
  echo "[bench] native_tool_call_bench: base + finetuned + quantized"
  ssh -o StrictHostKeyChecking=no "$target" "bash -lc '
    set -euo pipefail
    cd $REMOTE_TRAIN_DIR
    export PATH=\$HOME/.local/bin:\$PATH
    base_id=\$(uv run --extra train python -c \"from scripts.training.model_registry import get; print(get(\\\"$REGISTRY_KEY\\\").hf_id)\")
    uv run --extra train python scripts/benchmark/native_tool_call_bench.py \\
        --model \$base_id \\
        --out-dir benchmarks/$RUN_NAME/base \\
        --max-per-bucket 200
    uv run --extra train python scripts/benchmark/native_tool_call_bench.py \\
        --model checkpoints/$RUN_NAME/final \\
        --out-dir benchmarks/$RUN_NAME/finetuned \\
        --max-per-bucket 200
  '"
  IFS=',' read -ra qs <<< "$QUANTIZE_AFTER"
  for q in "${qs[@]}"; do
    ssh -o StrictHostKeyChecking=no "$target" "bash -lc '
      set -euo pipefail
      cd $REMOTE_TRAIN_DIR
      export PATH=\$HOME/.local/bin:\$PATH
      if [ -d checkpoints/$RUN_NAME/final-${q} ]; then
        uv run --extra train python scripts/benchmark/native_tool_call_bench.py \\
          --model checkpoints/$RUN_NAME/final-${q} \\
          --out-dir benchmarks/$RUN_NAME/${q} \\
          --max-per-bucket 200
      fi
    '" || true
  done
}

fetch() {
  local target
  target="$(ssh_target)"
  echo "[fetch] rsyncing checkpoints + benchmarks back"
  mkdir -p "$ROOT/checkpoints/$RUN_NAME" "$ROOT/benchmarks/$RUN_NAME"
  rsync -avh --info=progress2 \
    "$target:$REMOTE_TRAIN_DIR/checkpoints/$RUN_NAME/" \
    "$ROOT/checkpoints/$RUN_NAME/"
  rsync -avh --info=progress2 \
    "$target:$REMOTE_TRAIN_DIR/benchmarks/$RUN_NAME/" \
    "$ROOT/benchmarks/$RUN_NAME/" || true
}

teardown() {
  echo "[teardown] deleting $NEBIUS_VM_NAME"
  nebius compute v1 instance delete --id "$NEBIUS_VM_NAME"
}

case "$cmd" in
  provision) provision ;;
  sync) sync_tree ;;
  run) run_remote ;;
  quantize) quantize_remote ;;
  bench) bench_remote ;;
  fetch) fetch ;;
  teardown) teardown ;;
  full)
    provision
    sync_tree
    run_remote
    quantize_remote
    bench_remote
    fetch
    ;;
  help|*)
    sed -n '1,52p' "$0"
    ;;
esac
