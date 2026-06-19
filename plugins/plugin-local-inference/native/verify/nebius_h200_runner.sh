#!/usr/bin/env bash
# nebius_h200_runner.sh — run local-inference CUDA verification on Nebius H200.
#
# This is intentionally inference-only. It reuses the current checkout rather
# than assuming a pushed branch, uploads one smoke GGUF, runs cuda_runner.sh on
# a single H200 SXM VM, fetches reports, then tears the VM down by default.
#
# Required:
#   NEBIUS_PROJECT_ID        defaults to `nebius configure get parent-id`
#   ELIZA_MTP_SMOKE_MODEL local GGUF to upload for graph smoke
#
# Optional:
#   NEBIUS_VM_NAME           default eliza-inference-h200
#   NEBIUS_VM_DISK_GB        default 256
#   NEBIUS_SUBNET_ID         auto-discovered from the project when unset
#   NEBIUS_IMAGE_FAMILY      default mk8s-worker-node-v-1-31-ubuntu24.04-cuda12.8
#   NEBIUS_KEEP_VM=1         leave VM/disk up after full/run failures
#   NEBIUS_REMOTE_DIR        default /opt/eliza-inference
#   NEBIUS_REMOTE_MODEL      default /opt/models/eliza-smoke.gguf
#
# Usage:
#   ./nebius_h200_runner.sh smoke
#   ./nebius_h200_runner.sh full
#   ./nebius_h200_runner.sh teardown

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$HERE" rev-parse --show-toplevel)"
NEBIUS_BIN="${NEBIUS_BIN:-$HOME/.nebius/bin/nebius}"

: "${NEBIUS_PROJECT_ID:=$("$NEBIUS_BIN" config get parent-id 2>/dev/null || true)}"
: "${NEBIUS_PROJECT_ID:?must export NEBIUS_PROJECT_ID or configure a Nebius parent-id}"
: "${NEBIUS_VM_NAME:=eliza-inference-h200}"
: "${NEBIUS_VM_DISK_GB:=256}"
: "${NEBIUS_SSH_USER:=ubuntu}"
: "${NEBIUS_IMAGE_FAMILY:=mk8s-worker-node-v-1-31-ubuntu24.04-cuda12.8}"
: "${NEBIUS_IMAGE_PARENT:=project-e00public-images}"
: "${NEBIUS_REMOTE_DIR:=/opt/eliza-inference}"
: "${NEBIUS_REMOTE_MODEL:=/opt/models/eliza-smoke.gguf}"
: "${NEBIUS_PLATFORM:=gpu-h200-sxm}"
: "${NEBIUS_PRESET:=1gpu-16vcpu-200gb}"

cmd="${1:-help}"

run_nebius() {
  timeout "${NEBIUS_CLI_TIMEOUT:-90s}" "$NEBIUS_BIN" "$@"
}

_id_by_name() {
  local kind="$1" name="$2"
  run_nebius compute v1 "$kind" list --parent-id "$NEBIUS_PROJECT_ID" --format json 2>/dev/null \
    | python3 -c "import sys,json
d=json.load(sys.stdin) or {}
n=sys.argv[1]
for it in d.get('items',[]):
  if it.get('metadata',{}).get('name')==n:
    print(it['metadata']['id'])
    break" "$name"
}

instance_id_by_name() { _id_by_name instance "$NEBIUS_VM_NAME"; }
boot_disk_id_by_name() { _id_by_name disk "${NEBIUS_VM_NAME}-boot"; }

vm_ip() {
  local iid; iid="$(instance_id_by_name)"
  [ -n "$iid" ] || return 1
  run_nebius compute v1 instance get --id "$iid" --format json 2>/dev/null \
    | python3 -c "import sys,json
d=json.load(sys.stdin)
for ni in d.get('status',{}).get('network_interfaces',[]) or []:
  pip=ni.get('public_ip_address',{}).get('address')
  if pip:
    print(pip.split('/')[0])
    break"
}

ssh_target() { echo "$NEBIUS_SSH_USER@$(vm_ip)"; }

cloud_init_userdata() {
  local pub; pub="$(cat "${NEBIUS_SSH_PUBLIC_KEY:-$HOME/.ssh/id_ed25519.pub}")"
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
  run_nebius vpc v1 subnet list --parent-id "$NEBIUS_PROJECT_ID" --format json 2>/dev/null \
    | python3 -c "import sys,json
d=json.load(sys.stdin) or {}
items=d.get('items',[])
print(items[0]['metadata']['id'] if items else '')"
}

resolve_image_id() {
  run_nebius compute v1 image get-latest-by-family \
    --image-family "$NEBIUS_IMAGE_FAMILY" \
    --parent-id "$NEBIUS_IMAGE_PARENT" \
    --format json 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['metadata']['id'])"
}

wait_for_ssh() {
  local target="$1" tries="${2:-90}"
  echo "[nebius_h200] waiting for ssh on $target"
  for _ in $(seq 1 "$tries"); do
    if ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 -o BatchMode=yes "$target" "echo ok" >/dev/null 2>&1; then
      return 0
    fi
    sleep 5
  done
  echo "[nebius_h200] ERROR: ssh did not become ready" >&2
  return 1
}

provision() {
  if [ -z "$(boot_disk_id_by_name)" ]; then
    local image subnet
    image="$(resolve_image_id)"
    subnet="$(discover_subnet)"
    [ -n "$image" ] || { echo "[nebius_h200] could not resolve image $NEBIUS_IMAGE_FAMILY" >&2; exit 1; }
    [ -n "$subnet" ] || { echo "[nebius_h200] could not discover subnet" >&2; exit 1; }
    echo "[nebius_h200] creating boot disk ${NEBIUS_VM_NAME}-boot from $image"
    run_nebius compute v1 disk create \
      --parent-id "$NEBIUS_PROJECT_ID" \
      --name "${NEBIUS_VM_NAME}-boot" \
      --size-gibibytes "$NEBIUS_VM_DISK_GB" \
      --type network_ssd \
      --source-image-id "$image"
  fi

  if [ -z "$(instance_id_by_name)" ]; then
    local disk subnet
    disk="$(boot_disk_id_by_name)"
    subnet="$(discover_subnet)"
    echo "[nebius_h200] creating instance $NEBIUS_VM_NAME platform=$NEBIUS_PLATFORM preset=$NEBIUS_PRESET"
    run_nebius compute v1 instance create \
      --parent-id "$NEBIUS_PROJECT_ID" \
      --name "$NEBIUS_VM_NAME" \
      --resources-platform "$NEBIUS_PLATFORM" \
      --resources-preset "$NEBIUS_PRESET" \
      --boot-disk-existing-disk-id "$disk" \
      --boot-disk-attach-mode read_write \
      --network-interfaces '[{"name":"eth0","subnet_id":"'"$subnet"'","ip_address":{},"public_ip_address":{}}]' \
      --cloud-init-user-data "$(cloud_init_userdata)"
  fi

  local target; target="$(ssh_target)"
  wait_for_ssh "$target"
  ssh -o StrictHostKeyChecking=no "$target" \
    'set -euo pipefail; sudo apt-get update -y; sudo apt-get install -y rsync git build-essential cmake ninja-build jq nodejs npm python3; nvidia-smi'
}

sync_repo() {
  : "${ELIZA_MTP_SMOKE_MODEL:?must set ELIZA_MTP_SMOKE_MODEL to a local GGUF}"
  local target; target="$(ssh_target)"
  echo "[nebius_h200] syncing focused checkout to $target:$NEBIUS_REMOTE_DIR"
  ssh -o StrictHostKeyChecking=no "$target" \
    "sudo rm -rf '$NEBIUS_REMOTE_DIR'; sudo mkdir -p '$NEBIUS_REMOTE_DIR'; sudo chown -R '$NEBIUS_SSH_USER:$NEBIUS_SSH_USER' '$NEBIUS_REMOTE_DIR'"

  rsync -az --ignore-missing-args \
    "$REPO_ROOT/package.json" \
    "$REPO_ROOT/bun.lock" \
    "$REPO_ROOT/tsconfig.json" \
    "$REPO_ROOT/AGENTS.md" \
    "$target:$NEBIUS_REMOTE_DIR/"

  ssh -o StrictHostKeyChecking=no "$target" \
    "mkdir -p '$NEBIUS_REMOTE_DIR/packages/app-core' '$NEBIUS_REMOTE_DIR/packages/native/plugins' '$NEBIUS_REMOTE_DIR/plugins/plugin-local-inference/native'"
  rsync -az --delete "$REPO_ROOT/packages/app-core/scripts/" "$target:$NEBIUS_REMOTE_DIR/packages/app-core/scripts/"
  rsync -az --delete "$REPO_ROOT/packages/native/plugins/qjl-cpu/" "$target:$NEBIUS_REMOTE_DIR/packages/native/plugins/qjl-cpu/"
  rsync -az --delete "$REPO_ROOT/packages/native/plugins/polarquant-cpu/" "$target:$NEBIUS_REMOTE_DIR/packages/native/plugins/polarquant-cpu/"
  rsync -az --delete "$REPO_ROOT/plugins/plugin-local-inference/native/cuda/" "$target:$NEBIUS_REMOTE_DIR/plugins/plugin-local-inference/native/cuda/"
  rsync -az --delete "$REPO_ROOT/plugins/plugin-local-inference/native/mtp/" "$target:$NEBIUS_REMOTE_DIR/plugins/plugin-local-inference/native/mtp/"
  rsync -az --delete "$REPO_ROOT/plugins/plugin-local-inference/native/include/" "$target:$NEBIUS_REMOTE_DIR/plugins/plugin-local-inference/native/include/"
  rsync -az --delete "$REPO_ROOT/plugins/plugin-local-inference/native/reference/" "$target:$NEBIUS_REMOTE_DIR/plugins/plugin-local-inference/native/reference/"
  rsync -az --delete "$REPO_ROOT/plugins/plugin-local-inference/native/verify/" "$target:$NEBIUS_REMOTE_DIR/plugins/plugin-local-inference/native/verify/"
  echo "[nebius_h200] syncing smoke model to $target:$NEBIUS_REMOTE_MODEL"
  ssh -o StrictHostKeyChecking=no "$target" "sudo mkdir -p $(dirname "$NEBIUS_REMOTE_MODEL"); sudo chown -R $NEBIUS_SSH_USER:$NEBIUS_SSH_USER $(dirname "$NEBIUS_REMOTE_MODEL")"
  rsync -az "$ELIZA_MTP_SMOKE_MODEL" "$target:$NEBIUS_REMOTE_MODEL"
}

run_remote() {
  local target report
  target="$(ssh_target)"
  report="hardware-results/nebius-h200-$(date -u +%Y%m%dT%H%M%SZ).json"
  echo "[nebius_h200] running cuda_runner on $target"
  ssh -o StrictHostKeyChecking=no "$target" "set -euo pipefail; cd '$NEBIUS_REMOTE_DIR/plugins/plugin-local-inference/native/verify'; ELIZA_MTP_SMOKE_MODEL='$NEBIUS_REMOTE_MODEL' CUDA_TARGET=linux-x64-cuda ./cuda_runner.sh --report '$report'"
}

fetch_reports() {
  local target
  target="$(ssh_target || true)"
  if [ -z "$target" ] || [ "$target" = "$NEBIUS_SSH_USER@" ]; then
    echo "[nebius_h200] no reachable VM IP; skipping fetch"
    return 0
  fi
  mkdir -p "$HERE/hardware-results"
  rsync -az "$target:$NEBIUS_REMOTE_DIR/plugins/plugin-local-inference/native/verify/hardware-results/" "$HERE/hardware-results/"
}

teardown() {
  local iid did
  iid="$(instance_id_by_name || true)"
  if [ -n "$iid" ]; then
    echo "[nebius_h200] deleting instance $NEBIUS_VM_NAME ($iid)"
    run_nebius compute v1 instance delete --id "$iid" || true
    sleep 10
  fi
  did="$(boot_disk_id_by_name || true)"
  if [ -n "$did" ]; then
    echo "[nebius_h200] deleting boot disk ${NEBIUS_VM_NAME}-boot ($did)"
    run_nebius compute v1 disk delete --id "$did" || true
  fi
}

smoke() {
  provision
  local target; target="$(ssh_target)"
  ssh -o StrictHostKeyChecking=no "$target" "uname -a; nvidia-smi -L"
}

full() {
  if [ "${NEBIUS_KEEP_VM:-0}" != "1" ]; then
    trap 'rc=$?; fetch_reports || true; teardown || true; exit $rc' EXIT
  fi
  provision
  sync_repo
  run_remote
  fetch_reports
}

case "$cmd" in
  provision) provision ;;
  sync) sync_repo ;;
  run) run_remote ;;
  fetch) fetch_reports ;;
  teardown) teardown ;;
  smoke) smoke ;;
  ip) vm_ip ;;
  full) full ;;
  *)
    sed -n '1,35p' "$0"
    ;;
esac
