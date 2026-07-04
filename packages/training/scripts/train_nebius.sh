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
# for the active 2b/4b/9b tiers; the 8×H200 `8gpu-128vcpu-1600gb` preset + FSDP
# for 27b — that preset is expensive, see the note below), boot-disk from the
# `mk8s-worker-node-v-1-31-ubuntu24.04-cuda12.8` public image (NVIDIA 570.x +
# CUDA 12.8 preinstalled), rsync `packages/training/` + the training corpus,
# `run_pipeline.py` (full chain: APOLLO SFT → gate bench → PolarQuant/QJL/
# quantization smoke/evals), fetch results, teardown.
#
# 27b cost note: the H200 platform offers only `1gpu-` and `8gpu-` presets — no
# 2-GPU preset. A 27b run on Nebius H200 therefore rents 8× H200 (~$30+/GPU-h
# class hardware → ~$240+/h). DO NOT launch the 27b tiers from this script
# without explicit operator confirmation. Prefer Vast (`train_vast.sh`) which
# can target a 2× or 4× H200/B200 box.
#
# eliza-1 cloud-tier targets (model_registry.py REGISTRY keys):
#   REGISTRY_KEY=gemma4-e2b   → eliza-1-2b     (single H200 — fits seq 8k)
#   REGISTRY_KEY=gemma4-e4b   → eliza-1-4b     (single H200)
#   REGISTRY_KEY=gemma4-12b   → eliza-1-9b     (single H200, ~80 GB peak)
#   REGISTRY_KEY=gemma4-31b  → eliza-1-27b    (8× H200 fallback; prefer Vast)
#
# Required env:
#   NEBIUS_PROJECT_ID          # the project (== parent-id), e.g. project-e00kfz6cpr00q21z892vec
#   HUGGING_FACE_HUB_TOKEN     # for gated Gemma access + pushing results
# Optional env:
#   REGISTRY_KEY               # default: gemma4-e2b
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
#                              #   (default: polarquant,turboquant,fused_turboquant,qjl)
#   BENCHMARK_AFTER            # 1 = base-vs-finetuned bench (default 1); 0 skips base bench
#   PUSH_AFTER                 # 1 = run_pipeline.py --publish at the tail (default 0 — fetch + publish locally)
#   MAX_STEPS                  # hard cap on remote SFT step count (forwarded
#                              #   to run_pipeline.py --max-steps → train_local.py
#                              #   --max-steps → Trainer(max_steps=N)). Default 0
#                              #   = use --epochs. Set to 1500 to fit a 12h H200
#                              #   budget at ~25 s/iter with one eval pass; the
#                              #   v4 incident (2026-05-13) lost work to a
#                              #   hardcoded 6h cap mid-epoch.
#   ELIZA_REMOTE_RUN_TIMEOUT_H # hours the remote-poll loop will wait before
#                              #   bailing (default 12, matches the watcher's
#                              #   teardown deadline). Override for longer 27B
#                              #   runs; setting too high risks billing past
#                              #   the watcher cap if the run hangs.
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
REGISTRY_KEY="${REGISTRY_KEY:-gemma4-e2b}"
RUN_NAME="${RUN_NAME:-${REGISTRY_KEY//./-}-apollo-$(date +%s)}"
QUANTIZE_AFTER="${QUANTIZE_AFTER:-polarquant,turboquant,fused_turboquant,qjl}"
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

# The transformer decoder-layer class FSDP wraps. All Gemma 4 tiers
# (E2B/E4B/12B/31B) share the single dense Gemma4DecoderLayer. Allow an
# operator override for emergency transformer releases that rename the
# class before this launcher is updated.
DEFAULT_FSDP_WRAP_CLS="Gemma4DecoderLayer"
FSDP_WRAP_CLS="${FSDP_WRAP_CLS:-$DEFAULT_FSDP_WRAP_CLS}"

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
  # benchmark/checkpoint outputs, and caches. The `**/__pycache__/` exclude
  # catches every pycache tree under packages/training (not just the top-level
  # benchmarks/__pycache__/) — those regenerate constantly under any local
  # pytest run and were producing rsync exit-24 ("some files vanished") +
  # killing the whole launcher under `set -e` (2026-05-12 incident).
  local rsync_rc=0
  rsync -avhz --delete \
    --exclude '.venv/' --exclude '.git/' --exclude 'wandb/' \
    --exclude 'data/raw/' --exclude 'data/normalized/' --exclude 'data/synthesized/' \
    --exclude 'data/final/' --exclude 'data/final-eliza1-fullcorpus/' --exclude 'datasets/' \
    --exclude 'checkpoints/' --exclude '.hypothesis/' --exclude '.logs/' --exclude '.pytest_cache/' \
    --exclude '**/__pycache__/' \
    --exclude 'benchmarks/eliza-1-*/' \
    "$ROOT/" "$target:$REMOTE_TRAIN_DIR/" || rsync_rc=$?
  # rsync exit 24 = "some files vanished before they could be transferred"
  # (transient pycache files regenerated mid-transfer). Harmless when the rest
  # of the transfer is intact — must NOT abort the launcher.
  if [ "$rsync_rc" -ne 0 ] && [ "$rsync_rc" -ne 24 ]; then
    echo "[train_nebius][sync] main rsync failed rc=$rsync_rc — aborting"
    return "$rsync_rc"
  fi
  [ "$rsync_rc" = "24" ] && echo "[train_nebius][sync] main rsync rc=24 (files vanished mid-transfer — harmless, continuing)"

  if [ "$SYNC_FULLCORPUS_SOURCES" = "1" ]; then
    echo "[train_nebius][sync] sending corpus sources (data/final/ + datasets/eliza1-sft-0_6b/) for remote rebuild"
    # The main rsync above excludes data/final/ and datasets/, so those dirs
    # don't exist on a fresh VM — rsync won't create 2-deep targets. mkdir first.
    ssh -o StrictHostKeyChecking=no "$target" "mkdir -p $REMOTE_TRAIN_DIR/data/final $REMOTE_TRAIN_DIR/datasets/eliza1-sft-0_6b"
    rsync_rc=0
    rsync -avhz --partial "$ROOT/data/final/" "$target:$REMOTE_TRAIN_DIR/data/final/" || rsync_rc=$?
    if [ "$rsync_rc" -ne 0 ] && [ "$rsync_rc" -ne 24 ]; then
      echo "[train_nebius][sync] data/final rsync failed rc=$rsync_rc"; return "$rsync_rc"
    fi
    rsync_rc=0
    rsync -avhz --partial "$ROOT/datasets/eliza1-sft-0_6b/" "$target:$REMOTE_TRAIN_DIR/datasets/eliza1-sft-0_6b/" || rsync_rc=$?
    if [ "$rsync_rc" -ne 0 ] && [ "$rsync_rc" -ne 24 ]; then
      echo "[train_nebius][sync] datasets/eliza1-sft-0_6b rsync failed rc=$rsync_rc"; return "$rsync_rc"
    fi
  else
    # Send exactly the corpus the run trains on (TRAIN/VAL/TEST dirs).
    for f in "$TRAIN_FILE" "$VAL_FILE" "$TEST_FILE"; do
      local d; d="$(dirname "$f")"
      ssh -o StrictHostKeyChecking=no "$target" "mkdir -p $REMOTE_TRAIN_DIR/$d"
      echo "[train_nebius][sync] sending $f"
      rsync_rc=0
      # NOTE: no — macOS ships openrsync (protocol 29) which
      # rejects that flag (rc=1, prints usage) and aborts the launch. This
      # script is launched from macOS dev machines, so keep to flags the system
      # rsync supports; progress output is noise in a non-interactive run anyway.
      rsync -avhz --partial "$ROOT/$f" "$target:$REMOTE_TRAIN_DIR/$f" || rsync_rc=$?
      if [ "$rsync_rc" -ne 0 ] && [ "$rsync_rc" -ne 24 ]; then
        echo "[train_nebius][sync] $f rsync failed rc=$rsync_rc"; return "$rsync_rc"
      fi
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

  # MAX_STEPS env caps the remote SFT step count. Default 0 = use --epochs.
  # Set MAX_STEPS=1500 when wall-clock budget is tight (12h H200 at ~25 s/iter
  # = ~2540 steps; 1500 fits with margin including the 50-min eval pass at the
  # save-checkpoint boundary). See .swarm/STATUS.md 2026-05-13 v4 incident.
  local max_steps_flag=""
  [ "${MAX_STEPS:-0}" -gt 0 ] 2>/dev/null && max_steps_flag="--max-steps ${MAX_STEPS}"

  echo "[train_nebius][run] run_pipeline.py registry=$REGISTRY_KEY run=$RUN_NAME world=$FSDP_WORLD_SIZE max_steps=${MAX_STEPS:-0}"
  echo "[train_nebius][run] corpus: train=$TRAIN_FILE val=$VAL_FILE test=$TEST_FILE rebuild_fullcorpus=$SYNC_FULLCORPUS_SOURCES upsample=$upsample"

  # Write the remote runner script (avoids quoting hell), then launch it under
  # tmux so it survives ssh drops. Poll the log for the sentinel.
  ssh -o StrictHostKeyChecking=no "$target" "cat > $REMOTE_TRAIN_DIR/.run_pipeline.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd $REMOTE_TRAIN_DIR
export PATH=\$HOME/.local/bin:\$PATH
# The Nebius mk8s public image leaves CUDA_VISIBLE_DEVICES set to "" in login
# shells, which makes transformers/accelerate fall back to CPU ("Device 0 seems
# unavailable"). Pin it so native_tool_call_bench.py / train_local.py use the H200.
export CUDA_VISIBLE_DEVICES=0
# accelerate's device_map="auto" mis-detects the H200 on this image and falls
# back to CPU placement (the model then trains single-threaded on CPU at ~10
# s/it with the GPU at 0% util holding only unused optimizer states) — tell
# train_local.py to skip device_map and .to() the GPU explicitly. (native_tool_call_bench.py
# still runs on CPU here — see the §11 caveat in the legacy CPU-bench report; --skip-base-bench
# from BENCHMARK_AFTER=0 avoids the base pass, the finetuned pass is ~3h CPU.)
export ELIZA_NO_DEVICE_MAP=1
export HF_HOME=/opt/hf-cache
sudo mkdir -p \$HF_HOME && sudo chown -R \$USER \$HF_HOME || true
${hf_tok:+export HUGGING_FACE_HUB_TOKEN='$hf_tok'; export HF_TOKEN='$hf_tok'}
export ELIZA1_FULLCORPUS_UPSAMPLE='$upsample'
uv sync --extra train
# The pinned torch (2.11+cu130) needs an NVIDIA driver >=580; the Nebius
# cuda12.8 public image ships 570.x (CUDA 12.8 only) so torch.cuda.is_available()
# is False. Swap to torch 2.11.0+cu128 (same torch version → ABI-compatible with
# liger/bitsandbytes/apollo; just a cu12 backend the 570 driver supports), drop
# the leftover cu13 nvidia stack, and force-refresh nvidia-cusparselt-cu12 (uv's
# uninstall can leave a stale dist-info without the .so). REMOTE_TORCH_OVERRIDE=skip
# disables this on an image whose driver is >=580.
# torch_swap_cu128 — idempotent: swaps the venv to torch 2.11.0+cu128 if the
# installed torch can't see CUDA (cu130 needs driver >=580; the Nebius cuda12.8
# image ships 570.x). Callable both at boot AND right before train_local.py: a
# bare \`uv run --extra train …\` re-syncs the env from the cu130-pinned lockfile,
# silently clobbering the swap and forcing CPU training — so after the first swap
# we set UV_NO_SYNC=1 (every later \`uv run\`, incl. the ones run_pipeline.py spawns
# internally, then uses .venv as-is) AND re-swap defensively if it still drifted.
torch_swap_cu128() {
  .venv/bin/python -c 'import torch,sys; sys.exit(0 if torch.cuda.is_available() else 1)' 2>/dev/null && return 0
  echo "[remote] torch can't see CUDA (cu130 needs driver >=580; have 570.x) — swapping to torch 2.11.0+cu128"
  uv pip uninstall --python .venv/bin/python torch torchvision triton 2>/dev/null || true
  cu13pkgs="\$(uv pip list --python .venv/bin/python 2>/dev/null | awk '/^nvidia-[a-z0-9-]+ /{print \$1}')"
  [ -n "\$cu13pkgs" ] && uv pip uninstall --python .venv/bin/python \$cu13pkgs 2>/dev/null || true
  uv pip install --python .venv/bin/python 'torch==2.11.0' --index-url https://download.pytorch.org/whl/cu128
  uv pip install --python .venv/bin/python --reinstall nvidia-cusparselt-cu12
  .venv/bin/python -c 'import torch; assert torch.cuda.is_available(), "still no CUDA after torch swap"; x=torch.randn(64,64,device="cuda"); _=(x@x).sum().item(); print("[remote] torch", torch.__version__, "cuda OK on", torch.cuda.get_device_name(0))'
}
if [ "${REMOTE_TORCH_OVERRIDE:-cu128}" != "skip" ]; then
  torch_swap_cu128
  # Freeze the env: no later \`uv run\` may re-sync away the cu128 torch.
  export UV_NO_SYNC=1 UV_FROZEN=1
fi
${hf_tok:+uv run hf auth login --token "\$HUGGING_FACE_HUB_TOKEN" --add-to-git-credential || true}
if [ "$SYNC_FULLCORPUS_SOURCES" = "1" ]; then
  echo "[remote] rebuilding data/final-eliza1-fullcorpus/ (upsample=\$ELIZA1_FULLCORPUS_UPSAMPLE)"
  uv run --extra train python scripts/build_eliza1_fullcorpus.py
fi
# Defensive re-check: if anything above re-synced the env (it shouldn't with
# UV_NO_SYNC=1), swap torch back to cu128 before run_pipeline.py spawns SFT.
[ "${REMOTE_TORCH_OVERRIDE:-cu128}" != "skip" ] && torch_swap_cu128
uv run --extra train $launch scripts/run_pipeline.py \\
  --registry-key $REGISTRY_KEY --run-name $RUN_NAME \\
  --epochs 1 --lr 1e-5 --use-liger on \\
  $max_steps_flag \\
  --train-file $TRAIN_FILE --val-file $VAL_FILE --test-file $TEST_FILE \\
  --eval-mode full --bench-per-bucket 200 --skip-throughput-bench \\
  --quantizers $QUANTIZE_AFTER --no-eliza1-bundle $base_bench_flag $push_flag $allow_unval_flag
echo "RUN_PIPELINE_DONE_OK"
EOF
  # NOTE: `bash ... 2>&1 | tee $log` makes `$?` reflect `tee`'s exit (always 0)
  # — masking real failures. Use ${PIPESTATUS[0]} to capture the script's
  # actual rc. Without this, a pre-Gemma SFT crash (chat-template TypeError,
  # 2026-05-12 incident) emitted `RUN_PIPELINE_EXIT=0`, the launcher saw
  # "success", and ran fetch + teardown over an empty checkpoint dir.
  ssh -o StrictHostKeyChecking=no "$target" "chmod +x $REMOTE_TRAIN_DIR/.run_pipeline.sh; tmux kill-session -t elizatrain 2>/dev/null || true; tmux new-session -d -s elizatrain \"bash $REMOTE_TRAIN_DIR/.run_pipeline.sh 2>&1 | tee $log; echo RUN_PIPELINE_EXIT=\\\${PIPESTATUS[0]} >> $log\""
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
    # ELIZA_REMOTE_RUN_TIMEOUT_H caps the remote-poll wall (in hours, default
    # 12 to match the watcher's 12h teardown deadline). Override via env:
    #   ELIZA_REMOTE_RUN_TIMEOUT_H=24 bash scripts/train_nebius.sh full ...
    # The v4 incident (2026-05-13) hit the prior 6h hardcoded cap mid-training
    # at step 1003/9615, with eval_loss=1.145 still descending — see
    # .swarm/STATUS.md.
    local max_min=$(( ${ELIZA_REMOTE_RUN_TIMEOUT_H:-12} * 60 ))
    if [ "$i" -gt "$max_min" ]; then echo "[train_nebius][run] ERROR: still running after ${ELIZA_REMOTE_RUN_TIMEOUT_H:-12}h — bailing (VM left up; ssh in to investigate or run teardown)"; return 1; fi
  done
}

fetch() {
  local target; target="$(ssh_target)"
  echo "[train_nebius][fetch] pulling checkpoints + benchmarks + reports + run log"
  mkdir -p "$ROOT/checkpoints/$RUN_NAME" "$ROOT/benchmarks/$RUN_NAME" "$ROOT/reports" "$ROOT/reports/logs"
  # Exclude training-resume-only state from the checkpoint fetch: optimizer.pt
  # (APOLLO state — for a 2b this is ~21 GB, larger than the model itself),
  # scheduler/rng/trainer_state. Pulling them keeps the (expensive) GPU box
  # alive for an extra hour of rsync for bytes only a resume would use — the
  # deployable model is model.safetensors + config. Set FETCH_OPTIMIZER=1 to
  # keep them when you actually intend to resume this run.
  local opt_excludes=""
  [ "${FETCH_OPTIMIZER:-0}" = "1" ] || opt_excludes="--exclude optimizer.pt --exclude scheduler.pt --exclude rng_state*.pth --exclude trainer_state.json"
  rsync -avhz $opt_excludes "$target:$REMOTE_TRAIN_DIR/checkpoints/$RUN_NAME/" "$ROOT/checkpoints/$RUN_NAME/" || true
  rsync -avhz "$target:$REMOTE_TRAIN_DIR/benchmarks/$RUN_NAME/" "$ROOT/benchmarks/$RUN_NAME/" || true
  rsync -avhz "$target:$REMOTE_TRAIN_DIR/reports/" "$ROOT/reports/" || true
  # Always pull the remote run log — it holds the finetune traceback, which is
  # the only way to diagnose an early failure once the box is torn down (the
  # poll loop only surfaces grep'd tails). Without this a failed run is a
  # black box.
  rsync -avhz "$target:$REMOTE_TRAIN_DIR/run_${RUN_NAME}.log" "$ROOT/reports/logs/run_${RUN_NAME}.log" || true
}

# --- MTP drafter distillation (REMOVED) -------------------------------
# The in-repo drafter distiller (scripts/distill_mtp_drafter.py) was deleted.
# Release-grade MTP drafter distillation is H100/H200-gated and now done out of
# band, not driven from this script. The supported no-train path converts the
# published Gemma-4 MTP drafter to the mtp-draft GGUF arch and A/B-validates it
# per plugins/plugin-local-inference/docs/gemma4-mtp-drafter-conversion.md, then
# stages the result at bundles/<tier>/mtp/drafter-<tier>.gguf.
run_distill_remote() {
  cat >&2 <<'MSG'
[train_nebius][distill] ERROR: in-repo MTP drafter distillation was removed.
scripts/distill_mtp_drafter.py no longer exists, so there is nothing to run on
the remote box. Release-grade MTP drafter distillation is H100/H200-gated and
done out of band.

Supported no-train path (no GPU box needed): convert the published Gemma-4 MTP
drafter to the mtp-draft GGUF arch and A/B-validate it, per
  plugins/plugin-local-inference/docs/gemma4-mtp-drafter-conversion.md
then stage the result at bundles/<tier>/mtp/drafter-<tier>.gguf.
MSG
  return 2
}

fetch_distill() {
  local target; target="$(ssh_target)"
  local tier="${MTP_TIER:-9b}"
  local out_dir="${MTP_OUT_DIR:-out/mtp-drafter-${tier}}"
  echo "[train_nebius][fetch-distill] pulling $out_dir + the run log"
  mkdir -p "$ROOT/$out_dir"
  rsync -avhz "$target:$REMOTE_TRAIN_DIR/$out_dir/" "$ROOT/$out_dir/" || true
  rsync -avhz "$target:$REMOTE_TRAIN_DIR/distill_${RUN_NAME}.log" "$ROOT/$out_dir/distill.log" 2>/dev/null || true
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
  distill) run_distill_remote ;;
  fetch-distill) fetch_distill ;;
  full)
    # EXIT trap: fetch-then-teardown. The v4 incident (2026-05-13) hit the
    # remote-poll cap → run_remote returned 1 → set -euo pipefail aborted the
    # `full` flow → fetch was skipped → checkpoint-500/-1000 stayed on the
    # remote VM, then teardown hung on an expired nebius CLI auth token.
    # Always attempt fetch first (rsync over ssh works even when nebius CLI
    # auth has lapsed), then attempt teardown.
    trap 'echo "[train_nebius] full: ensuring fetch + teardown on exit"; fetch || true; teardown || true' EXIT
    provision
    sync_tree
    run_remote
    fetch
    ;;
  distill-full)
    # The remote MTP-drafter distillation path was removed (the in-repo
    # distiller scripts are gone; release-grade distillation is H100/H200-gated
    # and done out of band — produce the drafter via the no-train convert + A/B
    # runbook instead). run_distill_remote hard-errors, so fail fast HERE before
    # provisioning a VM / rsyncing the tree (avoids a wasteful spin-up + teardown).
    run_distill_remote
    ;;
  help|*) sed -n '1,80p' "$0" ;;
esac
