#!/usr/bin/env bash
# =============================================================================
# Nebius H200 training launcher for the eliza-1 fused-model line.
#
# Vast.ai is the canonical cloud (see scripts/train_vast.sh). This script is the
# Nebius fallback. It was rewritten 2026-05-12 against the live `nebius` CLI
# (v0.12.x): `instance create` now requires `--parent-id`, `--resources-platform`
# + `--resources-preset`, an *existing* boot disk (`--boot-disk-existing-disk-id`
# — there is no inline create-from-image), a real subnet id, and ssh keys go in
# via `--cloud-init-user-data`. The old `--project-id` / `--boot-disk-spec` /
# `"default"`-subnet shape is gone.
#
# Flow: provision a Nebius VM (single H200 SXM `gpu-h200-sxm` / `1gpu-16vcpu-200gb`
# for the 0.6b/1.7b/4b/9b tiers; the 8×H200 `8gpu-128vcpu-1600gb` preset + FSDP
# for 27b — that preset is expensive, see the note below), boot-disk from the
# `mk8s-worker-node-v-1-31-ubuntu24.04-cuda12.8` public image (NVIDIA 570.x +
# CUDA 12.8 preinstalled), rsync `packages/training/` + the training corpus,
# `run_pipeline.py` (full chain: APOLLO SFT → gate bench → PolarQuant/QJL/
# fused-TurboQuant quant → eliza1-typed GGUF bundle), fetch results, teardown.
#
# 27b cost note: the H200 platform offers only `1gpu-` and `8gpu-` presets — no
# 2-GPU preset. A 27b run on Nebius H200 therefore rents 8× H200 (~$30+/GPU-h
# class hardware → ~$240+/h). DO NOT launch the 27b tiers from this script
# without explicit operator confirmation. Prefer Vast (`train_vast.sh`) which
# can target a 2× or 4× H200/B200 box.
#
# eliza-1 cloud-tier targets (model_registry.py REGISTRY keys):
#   REGISTRY_KEY=qwen3-0.6b   → eliza-1-0_6b   (single H200 — overkill, ~2 GPU-h)
#   REGISTRY_KEY=qwen3-1.7b   → eliza-1-1_7b   (single H200 — fits seq 4096 easily)
#   REGISTRY_KEY=qwen3-4b     → eliza-1-4b     (single H200)
#   REGISTRY_KEY=qwen3.5-9b   → eliza-1-9b     (single H200, ~80 GB peak)
#   REGISTRY_KEY=qwen3.6-27b  → eliza-1-27b    (8× H200 + FSDP — HOLD, see above)
#
# Required env:
#   NEBIUS_PROJECT_ID          # the project (== parent-id), e.g. project-e00kfz6cpr00q21z892vec
#   HUGGING_FACE_HUB_TOKEN     # for gated Qwen access + pushing results
# Optional env:
#   REGISTRY_KEY               # default: qwen3-0.6b
#   RUN_NAME                   # default: <registry-key>-apollo-<unix-ts>
#   NEBIUS_VM_PRESET           # gpu-h200x1 (default) | gpu-h200x2 — selects the
#                              #   platform/preset pair. x2 == 8×H200 (no 2-GPU
#                              #   preset exists; only used for 27b, expensive).
#   FSDP_WORLD_SIZE            # default 1 (single GPU) / 8 (gpu-h200x2)
#   NEBIUS_SUBNET_ID           # default: auto-discover the project's subnet
#   NEBIUS_IMAGE_FAMILY        # default: mk8s-worker-node-v-1-31-ubuntu24.04-cuda12.8
#   NEBIUS_VM_DISK_GB          # default: 512
#   TRAIN_FILE / VAL_FILE / TEST_FILE
#                              # corpus paths (relative to packages/training/) the
#                              #   remote run trains on. Default: data/final/{train,val,test}.jsonl;
#                              #   set to data/final-eliza1-fullcorpus/{train,val,test}.jsonl
#                              #   for the combined benchmark-aligned + broad-mix corpus.
#   SYNC_FULLCORPUS_SOURCES    # 1 = also rsync datasets/eliza1-sft-0_6b/ + rebuild
#                              #   data/final-eliza1-fullcorpus/ on the remote
#                              #   (instead of rsyncing the prebuilt 940 MB combined
#                              #   splits). Default 0.
#   QUANTIZE_AFTER             # passed to run_pipeline.py --quantizers
#                              #   (default: polarquant,fused_turboquant,qjl)
#   BENCHMARK_AFTER            # 1 = base-vs-finetuned bench (default 1); 0 skips base bench
#   PUSH_AFTER                 # 1 = run_pipeline.py --publish at the tail (default 0 — fetch + publish locally)
#
# Usage:
#   bash scripts/train_nebius.sh smoke       # cheap CPU instance up → uname → teardown (pennies)
#   bash scripts/train_nebius.sh provision   # spin up the GPU VM (boot disk + instance)
#   bash scripts/train_nebius.sh sync        # rsync training tree + corpus to the VM
#   bash scripts/train_nebius.sh run         # remote: run_pipeline.py (SFT → gate → quant → bundle)
#   bash scripts/train_nebius.sh fetch       # rsync checkpoints + benchmarks + reports back
#   bash scripts/train_nebius.sh teardown    # delete the VM + its boot disk
#   bash scripts/train_nebius.sh full        # provision → sync → run → fetch → teardown
#   bash scripts/train_nebius.sh ip          # print the VM public IP

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

: "${NEBIUS_PROJECT_ID:?must export NEBIUS_PROJECT_ID (the Nebius project == --parent-id)}"
: "${NEBIUS_VM_NAME:=eliza-train-h200}"
: "${NEBIUS_VM_PRESET:=gpu-h200x1}"
: "${NEBIUS_VM_DISK_GB:=512}"
: "${NEBIUS_SSH_USER:=ubuntu}"
: "${NEBIUS_IMAGE_FAMILY:=mk8s-worker-node-v-1-31-ubuntu24.04-cuda12.8}"
: "${NEBIUS_IMAGE_PARENT:=project-e00public-images}"

REMOTE_TRAIN_DIR="/opt/training"
REGISTRY_KEY="${REGISTRY_KEY:-qwen3-0.6b}"
RUN_NAME="${RUN_NAME:-${REGISTRY_KEY//./-}-apollo-$(date +%s)}"
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

# The transformer decoder-layer class FSDP wraps. Qwen3-0.6B/1.7B/4B use
# Qwen3DecoderLayer; the (larger) Qwen3.5/3.6 checkpoints use Qwen3_5DecoderLayer.
case "$REGISTRY_KEY" in
  qwen3-0.6b|qwen3-1.7b|qwen3-4b) FSDP_WRAP_CLS="Qwen3DecoderLayer" ;;
  *) FSDP_WRAP_CLS="Qwen3_5DecoderLayer" ;;
esac

cmd="${1:-help}"

# --- helpers ----------------------------------------------------------------

_id_by_name() {
  # $1 = subcommand (instance|disk), $2 = name
  nebius compute v1 "$1" list --parent-id "$NEBIUS_PROJECT_ID" --format json 2>/dev/null \
    | python3 -c "import sys,json
d=json.load(sys.stdin) or {}
n=sys.argv[1]
for it in d.get('items',[]):
  if it.get('metadata',{}).get('name')==n:
    print(it['metadata']['id']); break" "$2"
}

instance_id_by_name() { _id_by_name instance "$NEBIUS_VM_NAME"; }
boot_disk_id_by_name() { _id_by_name disk "${NEBIUS_VM_NAME}-boot"; }

vm_ip() {
  local iid; iid="$(instance_id_by_name)"
  [ -n "$iid" ] || { echo "[train_nebius] no instance named $NEBIUS_VM_NAME in $NEBIUS_PROJECT_ID" >&2; return 1; }
  nebius compute v1 instance get --id "$iid" --format json 2>/dev/null \
    | python3 -c "import sys,json
d=json.load(sys.stdin)
nis=d.get('status',{}).get('network_interfaces',[]) or []
for ni in nis:
  pip=ni.get('public_ip_address',{}).get('address')
  if pip: print(pip.split('/')[0]); break"
}

ssh_target() { echo "$NEBIUS_SSH_USER@$(vm_ip)"; }

cloud_init_userdata() {
  # cloud-init that creates the login user with our pubkey.
  local pub; pub="$(cat ~/.ssh/id_ed25519.pub)"
  cat <<EOF
#cloud-config
users:
  - name: $NEBIUS_SSH_USER
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    ssh_authorized_keys:
      - $pub
EOF
}

discover_subnet() {
  [ -n "${NEBIUS_SUBNET_ID:-}" ] && { echo "$NEBIUS_SUBNET_ID"; return 0; }
  nebius vpc v1 subnet list --parent-id "$NEBIUS_PROJECT_ID" --format json 2>/dev/null \
    | python3 -c "import sys,json
d=json.load(sys.stdin) or {}
its=d.get('items',[])
print(its[0]['metadata']['id'] if its else '')"
}

resolve_image_id() {
  nebius compute v1 image get-latest-by-family \
    --image-family "$NEBIUS_IMAGE_FAMILY" --parent-id "$NEBIUS_IMAGE_PARENT" --format json 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['metadata']['id'])"
}

wait_for_ssh() {
  local target="$1" tries="${2:-90}"
  echo "[train_nebius] waiting for ssh on $target ..."
  for _ in $(seq 1 "$tries"); do
    if ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 -o BatchMode=yes "$target" "echo ok" 2>/dev/null; then
      return 0
    fi
    sleep 5
  done
  echo "[train_nebius] ERROR: $target never became ssh-reachable" >&2
  return 1
}

# --- provision / smoke ------------------------------------------------------

# $1 = platform, $2 = preset, $3 = disk-name, $4 = disk-gib
_create_disk_and_instance() {
  local platform="$1" preset="$2" disk_name="$3" disk_gib="$4"
  local subnet image_id
  subnet="$(discover_subnet)"; [ -n "$subnet" ] || { echo "[train_nebius] no subnet found in $NEBIUS_PROJECT_ID" >&2; exit 1; }
  image_id="$(resolve_image_id)"; [ -n "$image_id" ] || { echo "[train_nebius] could not resolve image family $NEBIUS_IMAGE_FAMILY" >&2; exit 1; }
  echo "[train_nebius] subnet=$subnet image=$image_id ($NEBIUS_IMAGE_FAMILY) platform=$platform preset=$preset"

  local existing_disk; existing_disk="$(boot_disk_id_by_name)"
  if [ -z "$existing_disk" ]; then
    echo "[train_nebius] creating boot disk $disk_name (${disk_gib} GiB, network_ssd, from $image_id)"
    nebius compute v1 disk create \
      --parent-id "$NEBIUS_PROJECT_ID" \
      --name "$disk_name" \
      --size-gibibytes "$disk_gib" \
      --type network_ssd \
      --source-image-id "$image_id"
    # wait for the disk to be READY
    for _ in $(seq 1 60); do
      existing_disk="$(boot_disk_id_by_name)"
      [ -n "$existing_disk" ] && break
      sleep 5
    done
  fi
  [ -n "$existing_disk" ] || { echo "[train_nebius] boot disk did not come up" >&2; exit 1; }
  echo "[train_nebius] boot disk = $existing_disk"

  echo "[train_nebius] creating instance $NEBIUS_VM_NAME"
  nebius compute v1 instance create \
    --parent-id "$NEBIUS_PROJECT_ID" \
    --name "$NEBIUS_VM_NAME" \
    --resources-platform "$platform" \
    --resources-preset "$preset" \
    --boot-disk-existing-disk-id "$existing_disk" \
    --boot-disk-attach-mode read_write \
    --network-interfaces '[{"name":"eth0","subnet_id":"'"$subnet"'","ip_address":{},"public_ip_address":{}}]' \
    --cloud-init-user-data "$(cloud_init_userdata)"
}

provision() {
  if [ -n "$(instance_id_by_name)" ]; then
    echo "[train_nebius] instance $NEBIUS_VM_NAME already exists — reusing"
  else
    _create_disk_and_instance "$NEBIUS_PLATFORM" "$NEBIUS_PRESET" "${NEBIUS_VM_NAME}-boot" "$NEBIUS_VM_DISK_GB"
  fi
  local target; target="$(ssh_target)"
  wait_for_ssh "$target"
  echo "[train_nebius] installing system deps (rsync git tmux jq + uv)"
  ssh -o StrictHostKeyChecking=no "$target" \
    'set -e; sudo apt-get update -y && sudo apt-get install -y rsync git tmux jq build-essential && curl -LsSf https://astral.sh/uv/install.sh | sh; nvidia-smi || true'
}

_smoke_teardown() {
  echo "[train_nebius][smoke] teardown"
  local iid did
  iid="$(instance_id_by_name)"; [ -n "$iid" ] && nebius compute v1 instance delete --id "$iid" >/dev/null 2>&1 || true
  sleep 8
  did="$(boot_disk_id_by_name)"; [ -n "$did" ] && nebius compute v1 disk delete --id "$did" >/dev/null 2>&1 || true
}

smoke() {
  # Cheap end-to-end of the provision path on a tiny CPU instance: create disk
  # from a driverless ubuntu image, create a cpu-e2/2vcpu-8gb instance, ssh in,
  # uname -a, then tear both down. Costs pennies, validates the CLI plumbing.
  NEBIUS_VM_NAME="eliza-train-smoke"
  NEBIUS_IMAGE_FAMILY="ubuntu24.04-driverless"
  echo "[train_nebius][smoke] === provision-path smoke (cpu-e2 / 2vcpu-8gb, 20 GiB) ==="
  trap _smoke_teardown EXIT
  _create_disk_and_instance "cpu-e2" "2vcpu-8gb" "${NEBIUS_VM_NAME}-boot" 20
  local target; target="$(ssh_target)"
  wait_for_ssh "$target" 90
  ssh -o StrictHostKeyChecking=no "$target" "uname -a && echo SMOKE_OK"
  echo "[train_nebius][smoke] OK — provision path works against the live CLI"
}

# --- sync / run / fetch -----------------------------------------------------

sync_tree() {
  local target; target="$(ssh_target)"
  echo "[train_nebius][sync] rsyncing packages/training/ → $target:$REMOTE_TRAIN_DIR"
  ssh -o StrictHostKeyChecking=no "$target" "sudo mkdir -p $REMOTE_TRAIN_DIR && sudo chown -R \$USER $REMOTE_TRAIN_DIR"
  # Keep the slim scripts/configs tree + benchmarks/ python+yaml (run_pipeline.py
  # imports benchmarks.eliza1_gates) but drop the big corpora, raw data, old
  # benchmark/checkpoint outputs, and caches.
  rsync -avhz --delete \
    --exclude '.venv/' --exclude '.git/' --exclude 'wandb/' \
    --exclude 'data/raw/' --exclude 'data/normalized/' --exclude 'data/synthesized/' \
    --exclude 'data/final/' --exclude 'data/final-eliza1-fullcorpus/' --exclude 'datasets/' \
    --exclude 'checkpoints/' --exclude '.hypothesis/' --exclude '.logs/' --exclude '.pytest_cache/' \
    --exclude 'benchmarks/eliza-1-*/' --exclude 'benchmarks/__pycache__/' \
    "$ROOT/" "$target:$REMOTE_TRAIN_DIR/"

  if [ "$SYNC_FULLCORPUS_SOURCES" = "1" ]; then
    echo "[train_nebius][sync] sending corpus sources (data/final/ + datasets/eliza1-sft-0_6b/) for remote rebuild"
    rsync -avhz --partial --info=progress2 "$ROOT/data/final/" "$target:$REMOTE_TRAIN_DIR/data/final/"
    rsync -avhz --partial "$ROOT/datasets/eliza1-sft-0_6b/" "$target:$REMOTE_TRAIN_DIR/datasets/eliza1-sft-0_6b/"
  else
    # Send exactly the corpus the run trains on (TRAIN/VAL/TEST dirs).
    for f in "$TRAIN_FILE" "$VAL_FILE" "$TEST_FILE"; do
      local d; d="$(dirname "$f")"
      ssh -o StrictHostKeyChecking=no "$target" "mkdir -p $REMOTE_TRAIN_DIR/$d"
      echo "[train_nebius][sync] sending $f"
      rsync -avhz --partial --info=progress2 "$ROOT/$f" "$target:$REMOTE_TRAIN_DIR/$f"
    done
  fi
}

run_remote() {
  local target; target="$(ssh_target)"
  local launch
  if [ "$FSDP_WORLD_SIZE" -gt 1 ]; then
    launch="accelerate launch --num_processes $FSDP_WORLD_SIZE --mixed_precision bf16 --use_fsdp --fsdp_sharding_strategy FULL_SHARD --fsdp_state_dict_type SHARDED_STATE_DICT --fsdp_offload_params false --fsdp_cpu_ram_efficient_loading true --fsdp_sync_module_states true --fsdp_use_orig_params true --fsdp_auto_wrap_policy TRANSFORMER_BASED_WRAP --fsdp_transformer_layer_cls_to_wrap $FSDP_WRAP_CLS --fsdp_backward_prefetch BACKWARD_PRE"
  else
    launch="python"
  fi
  local push_flag="--skip-publish"
  [ "$PUSH_AFTER" = "1" ] && push_flag="--publish"
  local base_bench_flag=""
  [ "$BENCHMARK_AFTER" = "1" ] || base_bench_flag="--skip-base-bench"
  local upsample="${ELIZA1_FULLCORPUS_UPSAMPLE:-1}"
  local hf_tok="${HUGGING_FACE_HUB_TOKEN:-${HF_TOKEN:-}}"
  local log="$REMOTE_TRAIN_DIR/run_${RUN_NAME}.log"
  # The eliza1-sft-0_6b mix-in rows are ChatML (`{"messages":[...]}`), which
  # validate_corpus.py (a native-record schema validator) cannot parse — so a
  # combined corpus that includes them needs --allow-unvalidated-corpus. The
  # build-time format_for_training.format_record gate already vets every row for
  # train_local.py compatibility. Set ALLOW_UNVALIDATED_CORPUS=0 to re-enable
  # the strict gate (only safe for a pure native-record corpus).
  local allow_unval_flag=""
  [ "${ALLOW_UNVALIDATED_CORPUS:-1}" = "1" ] && allow_unval_flag="--allow-unvalidated-corpus"

  echo "[train_nebius][run] run_pipeline.py registry=$REGISTRY_KEY run=$RUN_NAME world=$FSDP_WORLD_SIZE"
  echo "[train_nebius][run] corpus: train=$TRAIN_FILE val=$VAL_FILE test=$TEST_FILE rebuild_fullcorpus=$SYNC_FULLCORPUS_SOURCES upsample=$upsample"

  # Write the remote runner script (avoids quoting hell), then launch it under
  # tmux so it survives ssh drops. Poll the log for the sentinel.
  ssh -o StrictHostKeyChecking=no "$target" "cat > $REMOTE_TRAIN_DIR/.run_pipeline.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd $REMOTE_TRAIN_DIR
export PATH=\$HOME/.local/bin:\$PATH
export HF_HOME=/opt/hf-cache
sudo mkdir -p \$HF_HOME && sudo chown -R \$USER \$HF_HOME || true
${hf_tok:+export HUGGING_FACE_HUB_TOKEN='$hf_tok'; export HF_TOKEN='$hf_tok'}
export ELIZA1_FULLCORPUS_UPSAMPLE='$upsample'
uv sync --extra train
${hf_tok:+uv run hf auth login --token "\$HUGGING_FACE_HUB_TOKEN" --add-to-git-credential || true}
if [ "$SYNC_FULLCORPUS_SOURCES" = "1" ]; then
  echo "[remote] rebuilding data/final-eliza1-fullcorpus/ (upsample=\$ELIZA1_FULLCORPUS_UPSAMPLE)"
  uv run --extra train python scripts/build_eliza1_fullcorpus.py
fi
uv run --extra train $launch scripts/run_pipeline.py \\
  --registry-key $REGISTRY_KEY --run-name $RUN_NAME \\
  --epochs 1 --lr 1e-5 --use-liger on \\
  --train-file $TRAIN_FILE --val-file $VAL_FILE --test-file $TEST_FILE \\
  --eval-mode full --bench-per-bucket 200 --skip-throughput-bench \\
  --quantizers $QUANTIZE_AFTER --eliza1-bundle $base_bench_flag $push_flag $allow_unval_flag
echo "RUN_PIPELINE_DONE_OK"
EOF
  ssh -o StrictHostKeyChecking=no "$target" "chmod +x $REMOTE_TRAIN_DIR/.run_pipeline.sh; tmux kill-session -t elizatrain 2>/dev/null || true; tmux new-session -d -s elizatrain \"bash $REMOTE_TRAIN_DIR/.run_pipeline.sh 2>&1 | tee $log; echo RUN_PIPELINE_EXIT=\\\$? >> $log\""
  echo "[train_nebius][run] launched under tmux 'elizatrain' on $target — log: $log"
  echo "[train_nebius][run] polling for completion (this is a long run)..."
  local i=0
  while true; do
    sleep 60; i=$((i+1))
    local tail_out; tail_out="$(ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 "$target" "tail -n 3 $log 2>/dev/null" 2>/dev/null || echo '(ssh hiccup)')"
    echo "[train_nebius][run] +$((i))m | $(echo "$tail_out" | tr '\n' ' ' | tr '\r' ' ' | tail -c 200)"
    if ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 "$target" "grep -q 'RUN_PIPELINE_EXIT=' $log 2>/dev/null"; then
      local rc; rc="$(ssh -o StrictHostKeyChecking=no "$target" "grep 'RUN_PIPELINE_EXIT=' $log | tail -1 | sed 's/.*=//'" 2>/dev/null || echo '?')"
      echo "[train_nebius][run] pipeline finished (RUN_PIPELINE_EXIT=$rc)"
      ssh -o StrictHostKeyChecking=no "$target" "grep -q RUN_PIPELINE_DONE_OK $log" || { echo "[train_nebius][run] WARN: did not see DONE_OK sentinel — run may have failed"; }
      [ "$rc" = "0" ] || return 1
      break
    fi
    if [ "$i" -gt 360 ]; then echo "[train_nebius][run] ERROR: still running after 6h — bailing (VM left up; ssh in to investigate or run teardown)"; return 1; fi
  done
}

fetch() {
  local target; target="$(ssh_target)"
  echo "[train_nebius][fetch] pulling checkpoints + benchmarks + reports"
  mkdir -p "$ROOT/checkpoints/$RUN_NAME" "$ROOT/benchmarks/$RUN_NAME" "$ROOT/reports"
  rsync -avhz --info=progress2 "$target:$REMOTE_TRAIN_DIR/checkpoints/$RUN_NAME/" "$ROOT/checkpoints/$RUN_NAME/" || true
  rsync -avhz --info=progress2 "$target:$REMOTE_TRAIN_DIR/benchmarks/$RUN_NAME/" "$ROOT/benchmarks/$RUN_NAME/" || true
  rsync -avhz --info=progress2 "$target:$REMOTE_TRAIN_DIR/reports/" "$ROOT/reports/" || true
}

teardown() {
  local iid did
  iid="$(instance_id_by_name)"
  if [ -n "$iid" ]; then
    echo "[train_nebius][teardown] deleting instance $NEBIUS_VM_NAME ($iid)"
    nebius compute v1 instance delete --id "$iid" || echo "[train_nebius] WARN: instance delete failed — delete manually: nebius compute v1 instance delete --id $iid"
    sleep 10
  else
    echo "[train_nebius][teardown] no instance named $NEBIUS_VM_NAME"
  fi
  did="$(boot_disk_id_by_name)"
  if [ -n "$did" ]; then
    echo "[train_nebius][teardown] deleting boot disk ${NEBIUS_VM_NAME}-boot ($did)"
    nebius compute v1 disk delete --id "$did" || echo "[train_nebius] WARN: disk delete failed — delete manually: nebius compute v1 disk delete --id $did"
  fi
}

case "$cmd" in
  smoke) smoke ;;
  provision) provision ;;
  sync) sync_tree ;;
  run) run_remote ;;
  fetch) fetch ;;
  teardown) teardown ;;
  ip) vm_ip ;;
  full)
    trap 'echo "[train_nebius] full: ensuring teardown on exit"; teardown || true' EXIT
    provision
    sync_tree
    run_remote
    fetch
    ;;
  help|*) sed -n '1,80p' "$0" ;;
esac
