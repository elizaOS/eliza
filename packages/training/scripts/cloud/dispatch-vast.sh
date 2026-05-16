#!/usr/bin/env bash
# dispatch-vast.sh — vast.ai-specific cloud dispatch for Eliza-1 kernel
# verification, benchmarking, and training.
#
# Sibling of dispatch-nebius.sh; both are normally selected by the thin
# selector run-on-cloud.sh (which forwards every flag here unchanged), but
# this script is also runnable directly.
#
# Fail-closed: it will NOT provision a paid instance unless BOTH
#   * --yes-i-will-pay is passed, AND
#   * VAST_API_KEY is set (or `vastai set api-key <key>` was previously run,
#     leaving ~/.config/vastai/vast_api_key on disk).
# --dry-run prints the provisioning plan and spends nothing.
#
# Usage (forwarded straight from run-on-cloud.sh; see also that script's --help):
#   dispatch-vast.sh --task build         --gpu h100   [--yes-i-will-pay]
#   dispatch-vast.sh --task kernel-verify --gpu h100   [--yes-i-will-pay]
#   dispatch-vast.sh --task bench         --gpu rtx4090 --tier 0_8b [--yes-i-will-pay]
#   dispatch-vast.sh --task train         --gpu b200    --tier 27b  [--yes-i-will-pay]
#   dispatch-vast.sh --task kernel-verify --gpu h100   --dry-run
#   dispatch-vast.sh --tier 9b            --dry-run                   # task defaults to train
#
# Env:
#   VAST_API_KEY   required for any real provisioning (also accepts ~/.config/vastai/vast_api_key)
#   SSH_PUBKEY     path to your ssh pubkey (default ~/.ssh/id_ed25519.pub)
#   ELIZA_DFLASH_SMOKE_MODEL  optional GGUF for the kernel-verify graph smoke
#   HF_TOKEN / HUGGING_FACE_HUB_TOKEN  forwarded by train_vast.sh for gated repos
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRAINING_DIR="$(cd "$HERE/.." && pwd)"          # packages/training/scripts
REPO_ROOT="$(git -C "$HERE" rev-parse --show-toplevel 2>/dev/null || cd "$HERE/../../../.." && pwd)"
RESULTS_DIR="$REPO_ROOT/packages/inference/verify/hardware-results"
BENCH_DIR="$REPO_ROOT/packages/inference/verify/bench_results"
DATE_TAG="$(date -u +%Y-%m-%d)"
GIT_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo HEAD)"
GIT_REMOTE="$(git -C "$REPO_ROOT" config --get remote.origin.url 2>/dev/null || echo 'https://github.com/elizaOS/eliza.git')"
TIER_ROUTING_JSON="$HERE/tier-routing.json"

TASK="train"
GPU=""
TIER="0_8b"
PAY=0
DRYRUN=0
SSH_PUBKEY="${SSH_PUBKEY:-$HOME/.ssh/id_ed25519.pub}"
SMOKE_MODEL="${ELIZA_DFLASH_SMOKE_MODEL:-}"

die() { echo "[dispatch-vast] ERROR: $*" >&2; exit 1; }
log() { echo "[dispatch-vast] $*" >&2; }
plan() {
  if [[ "$DRYRUN" == 1 ]]; then
    echo "[dispatch-vast][dry-run] $*"
  else
    eval "$@"
  fi
}

print_help() { sed -n '2,30p' "$0"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --task)         TASK="${2:-}"; shift 2 ;;
    --gpu)          GPU="${2:-}"; shift 2 ;;
    --tier)         TIER="${2:-}"; shift 2 ;;
    --ssh-pubkey)   SSH_PUBKEY="${2:-}"; shift 2 ;;
    --smoke-model)  SMOKE_MODEL="${2:-}"; shift 2 ;;
    --yes-i-will-pay) PAY=1; shift ;;
    --dry-run)      DRYRUN=1; shift ;;
    -h|--help)      print_help; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

case "$TASK" in build|kernel-verify|bench|train) ;; *) die "unknown task '$TASK' (build|kernel-verify|bench|train)" ;; esac
case "$TIER" in 0_8b|2b|4b|9b|27b) ;; *) die "unknown tier '$TIER' (0_8b|2b|4b|9b|27b)" ;; esac

# --- tier → defaults from tier-routing.json -----------------------------------
# Use the routing table to pick a default GPU + min VRAM when --gpu is not set.
# This keeps the routing rule honest: dispatch reads the same JSON the selector
# uses for auto-routing.
read_tier_field() {
  python3 -c "import json,sys;d=json.load(open(\"$TIER_ROUTING_JSON\"));print(d['tiers']['$TIER'].get('$1',''))" 2>/dev/null || echo ""
}
MIN_VRAM_GB="$(read_tier_field min_vram_gb)"
DEFAULT_VAST_GPU="$(read_tier_field default_vast_gpu)"
[[ -n "$GPU" ]] || GPU="${DEFAULT_VAST_GPU:-h100}"

# --- GPU friendly name → vastai search clause / train_vast token --------------
gpu_to_vast_query() {
  case "$1" in
    h100)            echo 'gpu_name=H100_SXM num_gpus=1' ;;
    h200)            echo 'gpu_name=H200 num_gpus=1' ;;
    a100)            echo 'gpu_name=A100_SXM4 num_gpus=1' ;;
    a100-80)         echo 'gpu_name=A100_SXM4 gpu_ram>=79 num_gpus=1' ;;
    rtx4090)         echo 'gpu_name=RTX_4090 num_gpus=1' ;;
    rtx5090)         echo 'gpu_name=RTX_5090 num_gpus=1' ;;
    l40s)            echo 'gpu_name=L40S num_gpus=1' ;;
    b200)            echo 'gpu_name=B200 num_gpus=2' ;;
    blackwell6000)   echo 'gpu_name=RTX_PRO_6000_Blackwell_WS num_gpus=1' ;;
    *) die "unknown --gpu '$1' (h100|h200|a100|a100-80|rtx4090|rtx5090|l40s|b200|blackwell6000)" ;;
  esac
}
gpu_to_train_vast_token() {
  case "$1" in
    h100) echo h100-1x ;; h200) echo h200-1x ;; b200) echo b200-2x ;;
    rtx5090) echo rtx5090-1x ;; blackwell6000) echo blackwell6000-1x ;;
    *) echo "" ;;
  esac
}
tier_to_registry_key() {
  case "$1" in
    0_8b) echo qwen3.5-0.8b ;;
    2b)   echo qwen3.5-2b ;;
    4b)   echo qwen3.5-4b ;;
    9b)   echo qwen3.5-9b ;;
    27b) echo qwen3.6-27b ;;
  esac
}

# --- minimum-VRAM gate --------------------------------------------------------
# Cross-check the user's --gpu against tier-routing.json's min_vram_gb so the
# dispatch fails before billing if the chosen card can't hold the tier.
gpu_vram_gb() {
  case "$1" in
    rtx4090) echo 24 ;;
    rtx5090) echo 32 ;;
    l40s)    echo 48 ;;
    a100)    echo 40 ;;
    a100-80) echo 80 ;;
    h100)    echo 80 ;;
    h200)    echo 141 ;;
    b200)    echo 192 ;;
    blackwell6000) echo 96 ;;
    *) echo 0 ;;
  esac
}
GPU_VRAM_GB="$(gpu_vram_gb "$GPU")"
if [[ -n "$MIN_VRAM_GB" && "$MIN_VRAM_GB" != "0" && "$GPU_VRAM_GB" -gt 0 && "$GPU_VRAM_GB" -lt "$MIN_VRAM_GB" ]]; then
  die "tier $TIER needs >=${MIN_VRAM_GB}GB VRAM; --gpu $GPU has only ${GPU_VRAM_GB}GB. Pick a bigger card."
fi

# --- task=train: delegate to the existing battle-tested launcher --------------
if [[ "$TASK" == "train" ]]; then
  REG_KEY="$(tier_to_registry_key "$TIER")"
  TOKEN="$(gpu_to_train_vast_token "$GPU")"
  CMD=(bash "$TRAINING_DIR/train_vast.sh" provision-and-train --registry-key "$REG_KEY" --epochs 1)

  echo "[dispatch-vast] === PLAN ==="
  echo "  provider   : vast.ai"
  echo "  task       : train   tier: $TIER"
  echo "  gpu        : $GPU    (train_vast token: ${TOKEN:-auto from registry})"
  echo "  registry   : $REG_KEY"
  echo "  cmd        : ${TOKEN:+VAST_GPU_TARGET=$TOKEN }${CMD[*]}"
  echo "[dispatch-vast] ============"

  if [[ "$DRYRUN" == 1 ]]; then
    echo "[dispatch-vast] DRY-RUN — no instance provisioned, no charges. Re-run without --dry-run and with --yes-i-will-pay to proceed."
    exit 0
  fi
  [[ "$PAY" == 1 ]] || die "refusing to provision without --yes-i-will-pay (train runs cost real money — see ../CLOUD_VAST.md)"
  [[ -n "${VAST_API_KEY:-}" || -f "$HOME/.config/vastai/vast_api_key" ]] || die "VAST_API_KEY not set (and no ~/.config/vastai/vast_api_key) — fail-closed"
  exec env ${TOKEN:+VAST_GPU_TARGET="$TOKEN"} "${CMD[@]}"
fi

# --- kernel-verify / bench / build: provision a single instance, run, pull ----
command -v vastai >/dev/null 2>&1 || [[ "$DRYRUN" == 1 ]] || die "the 'vastai' CLI is required: pip install --user vastai"
VAST_Q="$(gpu_to_vast_query "$GPU")"
IMAGE="nvidia/cuda:12.8.0-devel-ubuntu24.04"
DISK_GB=80

REMOTE_SCRIPT="$(cat <<REMOTE
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -q && apt-get install -y -q git curl ca-certificates build-essential cmake unzip
curl -fsSL https://bun.sh/install | bash
export PATH="\$HOME/.bun/bin:\$PATH"
nvidia-smi -L
nvcc --version
git clone --filter=blob:none "$GIT_REMOTE" eliza
cd eliza
git checkout "$GIT_SHA"
bun install --frozen-lockfile || bun install
ELIZA_DFLASH_SKIP_SERVER_STRUCTURED_OUTPUT=1 node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target linux-x64-cuda
make -C packages/inference/verify kernel-contract reference-test
REMOTE
)"

case "$TASK" in
  build)
    OUT="$RESULTS_DIR/cuda-build-${GPU}-${DATE_TAG}.json"
    REMOTE_TASK="$(cat <<REMOTE
ldd packages/inference/native/dist/linux-x64-cuda/libelizainference.so | tee /workspace/build-ldd.txt
printf '{"schemaVersion":1,"runner":"dispatch-vast build","status":"pass","gpu":"%s"}\n' "$GPU" > /workspace/cuda-report.json
REMOTE
)"
    PULL_REMOTE="/workspace/cuda-report.json:$OUT"
    mkdir -p "$RESULTS_DIR"
    ;;
  kernel-verify)
    OUT="$RESULTS_DIR/cuda-linux-${GPU}-${DATE_TAG}.json"
    REMOTE_TASK="$(cat <<REMOTE
make -C packages/inference/verify cuda-verify
make -C packages/inference/verify cuda-verify-fused
${SMOKE_MODEL:+export ELIZA_DFLASH_SMOKE_MODEL=/workspace/smoke.gguf}
${SMOKE_MODEL:+packages/inference/verify/cuda_runner.sh --report /tmp/cuda-report.json} \
  ${SMOKE_MODEL:+|| true}
${SMOKE_MODEL:+test -f /tmp/cuda-report.json && cp /tmp/cuda-report.json /workspace/cuda-report.json}
${SMOKE_MODEL:+:} || cat > /workspace/cuda-report.json <<'JSON'
{"schemaVersion":1,"runner":"dispatch-vast kernel-verify","status":"pass","passRecordable":false,
 "exitCode":0,"note":"cuda-verify + cuda-verify-fused fixture parity only; no ELIZA_DFLASH_SMOKE_MODEL → graph smoke skipped, so this is NOT a runtime-ready record. Pass --smoke-model to upgrade."}
JSON
REMOTE
)"
    PULL_REMOTE="/workspace/eliza/cuda-report.json:$OUT /workspace/cuda-report.json:$OUT"
    mkdir -p "$RESULTS_DIR"
    ;;
  bench)
    REG_KEY="$(tier_to_registry_key "$TIER")"
    OUT="$BENCH_DIR/cuda_${GPU}_${TIER}_${DATE_TAG}.json"
    REMOTE_TASK="$(cat <<REMOTE
ELIZA1_BENCH_TIER=$TIER ELIZA1_BENCH_REGISTRY_KEY=$REG_KEY \
  node packages/inference/verify/eliza1_gates_collect.mjs --backend cuda --bench --out /workspace/bench.json || \
  { echo "bench harness not present on this commit — emitting toolchain-only stub"; \
    printf "{\"schemaVersion\":1,\"backend\":\"cuda\",\"gpu\":\"%s\",\"tier\":\"%s\",\"status\":\"toolchain-only\",\"note\":\"eliza1 bench harness not on this commit\"}\\n" "$GPU" "$TIER" > /workspace/bench.json; }
cp /workspace/bench.json /workspace/eliza/bench.json 2>/dev/null || true
REMOTE
)"
    PULL_REMOTE="/workspace/bench.json:$OUT /workspace/eliza/bench.json:$OUT"
    mkdir -p "$BENCH_DIR"
    ;;
esac

# --- provisioning plan --------------------------------------------------------
echo "[dispatch-vast] === PLAN ==="
echo "  provider     : vast.ai"
echo "  task         : $TASK   tier: $TIER"
echo "  gpu          : $GPU   (vastai filter: $VAST_Q   vram: ${GPU_VRAM_GB}GB, tier-min: ${MIN_VRAM_GB:-?}GB)"
echo "  image        : $IMAGE   disk: ${DISK_GB}GB"
echo "  repo         : $GIT_REMOTE @ $GIT_SHA"
echo "  ssh pubkey   : $SSH_PUBKEY"
echo "  smoke model  : ${SMOKE_MODEL:-<none — graph smoke skipped, parity-only>}"
echo "  results -> $OUT"
echo "[dispatch-vast] ============"

if [[ "$DRYRUN" == 1 ]]; then
  echo "[dispatch-vast] DRY-RUN — would now run:"
  echo "  vastai search offers '$VAST_Q rentable=true reliability>0.97 disk_space>=$DISK_GB inet_down>=200' --raw"
  echo "  vastai create instance <offer-id> --image $IMAGE --disk $DISK_GB --ssh --direct --onstart-cmd 'touch /workspace/.ready' --raw"
  echo "  ssh <instance> 'bash -l /workspace/bootstrap.sh'   # task=$TASK"
  echo "  scp <instance>:/workspace/*.json $OUT"
  echo "  vastai destroy instance <instance-id>"
  echo "[dispatch-vast] no instance provisioned, no charges."
  exit 0
fi

[[ "$PAY" == 1 ]] || die "refusing to provision without --yes-i-will-pay (this rents a paid GPU)"
[[ -n "${VAST_API_KEY:-}" || -f "$HOME/.config/vastai/vast_api_key" ]] || die "VAST_API_KEY not set (and no ~/.config/vastai/vast_api_key) — fail-closed, no provisioning"
[[ -f "$SSH_PUBKEY" ]] || die "ssh pubkey not found: $SSH_PUBKEY (pass --ssh-pubkey)"
[[ -z "${VAST_API_KEY:-}" ]] || vastai set api-key "$VAST_API_KEY" >/dev/null 2>&1 || true

# 1. Pick the cheapest reliable offer.
log "searching offers..."
OFFER_ID="$(vastai search offers "$VAST_Q rentable=true reliability>0.97 disk_space>=$DISK_GB inet_down>=200" \
  --raw 2>/dev/null | python3 -c 'import sys,json;o=json.load(sys.stdin);o.sort(key=lambda x:x.get("dph_total",1e9));print(o[0]["id"] if o else "")')"
[[ -n "$OFFER_ID" ]] || die "no matching vast.ai offer for: $VAST_Q"
log "selected offer $OFFER_ID"

# 2. Provision.
INSTANCE_ID="$(vastai create instance "$OFFER_ID" \
  --image "$IMAGE" --disk "$DISK_GB" \
  --ssh --direct \
  --onstart-cmd "touch /workspace/.ready" \
  --raw 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin).get("new_contract",""))')"
[[ -n "$INSTANCE_ID" ]] || die "vastai create did not return an instance id"
echo "$INSTANCE_ID" > "$HERE/.run_on_cloud_instance_id"
log "provisioned instance $INSTANCE_ID — will tear down on exit"

cleanup() {
  log "tearing down instance $INSTANCE_ID..."
  vastai destroy instance "$INSTANCE_ID" >/dev/null 2>&1 || log "WARN: teardown failed — destroy it manually: vastai destroy instance $INSTANCE_ID"
  rm -f "$HERE/.run_on_cloud_instance_id"
}
trap cleanup EXIT

# 3. Wait for ssh.
log "waiting for ssh..."
for i in $(seq 1 60); do
  SSH_URL="$(vastai ssh-url "$INSTANCE_ID" 2>/dev/null || true)"
  [[ -n "$SSH_URL" ]] && timeout 8 ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 "${SSH_URL#ssh://}" true 2>/dev/null && break
  sleep 10
done
[[ -n "${SSH_URL:-}" ]] || die "instance never became ssh-reachable"
SSH_HOSTPORT="${SSH_URL#ssh://}"
log "ssh up: $SSH_HOSTPORT"

# 4. (optional) push the smoke model.
if [[ -n "$SMOKE_MODEL" ]]; then
  [[ -f "$SMOKE_MODEL" ]] || die "--smoke-model file not found: $SMOKE_MODEL"
  log "uploading smoke model ($(du -h "$SMOKE_MODEL" | cut -f1))..."
  scp -o StrictHostKeyChecking=no "$SMOKE_MODEL" "${SSH_HOSTPORT%:*}:/workspace/smoke.gguf"
fi

# 5. Run bootstrap + task.
log "running bootstrap + $TASK on the instance (this can take 10-40 min)..."
ssh -o StrictHostKeyChecking=no "$SSH_HOSTPORT" "bash -lc 'mkdir -p /workspace && cd /workspace && cat > bootstrap.sh' " <<< "$REMOTE_SCRIPT"$'\n'"$REMOTE_TASK"
ssh -o StrictHostKeyChecking=no "$SSH_HOSTPORT" "bash -l /workspace/bootstrap.sh"

# 6. Pull evidence.
for pair in $PULL_REMOTE; do
  rpath="${pair%%:*}"; lpath="${pair##*:}"
  if scp -o StrictHostKeyChecking=no "${SSH_HOSTPORT%:*}:$rpath" "$lpath" 2>/dev/null; then
    log "pulled $rpath -> $lpath"
  fi
done

log "done. Evidence in: $OUT"
log "(instance $INSTANCE_ID will be destroyed by the EXIT trap)"
