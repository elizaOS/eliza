#!/usr/bin/env bash
# run-on-cloud.sh — one-line remote-GPU runner for Eliza-1 kernel verification,
# benchmarking, and training. Fails closed: it will NOT provision a paid
# instance unless you pass --yes-i-will-pay AND the relevant API-key env var is
# set. --dry-run prints the provisioning plan and spends nothing.
#
# This is the selector front door. If --provider is omitted, tier-routing.json
# chooses vast.ai or Nebius, then this script forwards every operational flag to
# dispatch-vast.sh or dispatch-nebius.sh.
#
# Usage:
#   run-on-cloud.sh --task train --tier 9b --dry-run                         # auto-routes
#   run-on-cloud.sh --provider vast   --task build         --gpu h100 --yes-i-will-pay
#   run-on-cloud.sh --provider vast   --task kernel-verify --gpu h100 [--yes-i-will-pay]
#   run-on-cloud.sh --provider vast   --task bench         --gpu rtx4090 --tier 2b --yes-i-will-pay
#   run-on-cloud.sh --provider vast   --task train         --gpu b200 --tier 27b --yes-i-will-pay
#   run-on-cloud.sh --provider nebius --task train         --gpu h200 --tier 2b --yes-i-will-pay
#   run-on-cloud.sh --provider vast   --task kernel-verify --gpu h100 --dry-run     # no spend
#
# Tasks:
#   kernel-verify  build linux-x64-cuda, `make -C packages/inference/verify
#                  cuda-verify cuda-verify-fused`, then `cuda_runner.sh --report`;
#                  pulls JSON to packages/inference/verify/hardware-results/.
#   bench          build linux-x64-cuda, run the e2e CUDA bench harness for the
#                  given --tier; pulls JSON to packages/inference/verify/bench_results/.
#   train          delegates to the selected provider dispatcher, which then
#                  calls ../train_vast.sh or ../train_nebius.sh.
#
# GPU friendly names (mapped to vastai search filters / train_vast GPU tokens):
#   h100 | h200 | a100 | a100-80 | rtx4090 | rtx5090 | b200 | l40s | blackwell6000
#
# Tiers (informational for kernel-verify; sizes the model for bench/train):
#   2b | 4b | 9b | 27b | 27b-256k
# The legacy pre-Gemma tiers (0_6b / 1_7b) were dropped 2026-05-12 — those bases
# don't work with the eliza-1 mtp spec-decode path.
#
# Required env per provider:
#   vast    VAST_API_KEY            (or `vastai set api-key <key>` beforehand)
#   nebius  NEBIUS_*                (see ../train_nebius.sh / ../CLOUD_VAST.md)
#   (train) HF_TOKEN / HUGGING_FACE_HUB_TOKEN for gated dataset/model repos
#   all     SSH_PUBKEY              path to an ssh pubkey (default ~/.ssh/id_ed25519.pub)
set -euo pipefail

# --------------------------------------------------------------------------
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRAINING_DIR="$(cd "$HERE/.." && pwd)"          # packages/training/scripts
REPO_ROOT="$(git -C "$HERE" rev-parse --show-toplevel)"
RESULTS_DIR="$REPO_ROOT/packages/inference/verify/hardware-results"
BENCH_DIR="$REPO_ROOT/packages/inference/verify/bench_results"
DATE_TAG="$(date -u +%Y-%m-%d)"
GIT_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
GIT_REMOTE="$(git -C "$REPO_ROOT" config --get remote.origin.url 2>/dev/null || echo 'https://github.com/elizaOS/eliza.git')"

ORIGINAL_ARGS=("$@")
PROVIDER=""
TASK=""
GPU="h100"
TIER="2b"
PAY=0
DRYRUN=0
SSH_PUBKEY="${SSH_PUBKEY:-$HOME/.ssh/id_ed25519.pub}"
SMOKE_MODEL="${ELIZA_MTP_SMOKE_MODEL:-}"     # optional GGUF for the graph smoke

die() { echo "[run-on-cloud] ERROR: $*" >&2; exit 1; }
log() { echo "[run-on-cloud] $*" >&2; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --provider) PROVIDER="${2:-}"; shift 2 ;;
    --task)     TASK="${2:-}"; shift 2 ;;
    --gpu)      GPU="${2:-}"; shift 2 ;;
    --tier)     TIER="${2:-}"; shift 2 ;;
    --ssh-pubkey) SSH_PUBKEY="${2:-}"; shift 2 ;;
    --smoke-model) SMOKE_MODEL="${2:-}"; shift 2 ;;
    --yes-i-will-pay) PAY=1; shift ;;
    --dry-run)  DRYRUN=1; shift ;;
    -h|--help)  sed -n '2,60p' "$0"; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

[[ -n "$TASK" ]]     || die "--task {kernel-verify,bench,train} is required"
case "$TASK" in build|kernel-verify|bench|train) ;; *) die "unknown task '$TASK'" ;; esac
case "$TIER" in 2b|4b|9b|27b|27b-256k) ;; *) die "unknown tier '$TIER'" ;; esac

TIER_ROUTING_JSON="$HERE/tier-routing.json"
if [[ -z "$PROVIDER" ]]; then
  PROVIDER="$(python3 -c "import json; d=json.load(open('$TIER_ROUTING_JSON')); print(d['tiers']['$TIER'].get('recommended_provider','vast'))" 2>/dev/null || echo vast)"
fi
case "$PROVIDER" in vast|nebius) ;; *) die "unknown provider '$PROVIDER'" ;; esac

FORWARD_ARGS=()
for ((i=0; i<${#ORIGINAL_ARGS[@]}; i++)); do
  arg="${ORIGINAL_ARGS[$i]}"
  case "$arg" in
    --provider) i=$((i+1)) ;;
    --provider=*) ;;
    *) FORWARD_ARGS+=("$arg") ;;
  esac
done
exec bash "$HERE/dispatch-${PROVIDER}.sh" "${FORWARD_ARGS[@]}"

# --------------------------------------------------------------------------
# GPU friendly name → vastai search clause + train_vast token.
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
    *) echo "" ;;   # let train_vast.sh auto-pick from the registry key
  esac
}
tier_to_registry_key() {
  # Keys must match scripts/training/model_registry.py REGISTRY. The canonical
  # eliza-1 fused-model line uses Gemma 4 for every tier (E2B/E4B/12B/31B).
  # The mtp kernels are validated against the Gemma 4 architecture + 262144
  # tokenizer; a non-Gemma base has the wrong vocab + attention shape for the
  # fused paths. The 0_6b/1_7b legacy tier ids in the runtime
  # manifest stay addressable but no longer route to a registry key.
  case "$1" in
    2b)        echo gemma4-e2b ;;
    4b)        echo gemma4-e4b ;;
    9b)        echo gemma4-12b ;;
    27b|27b-256k) echo gemma4-31b ;;
  esac
}

# --------------------------------------------------------------------------
# --task train: delegate to the existing battle-tested launcher.
if [[ "$TASK" == "train" ]]; then
  [[ "$PROVIDER" == "vast" ]] || die "--task train --provider $PROVIDER not wired here; run ../train_nebius.sh directly for Nebius (emergency fallback only)"
  REG_KEY="$(tier_to_registry_key "$TIER")"
  TOKEN="$(gpu_to_train_vast_token "$GPU")"
  CMD=(bash "$TRAINING_DIR/train_vast.sh" provision-and-train --registry-key "$REG_KEY" --epochs 1)
  log "delegating to train_vast.sh — registry-key=$REG_KEY gpu-token=${TOKEN:-auto}"
  if [[ "$DRYRUN" == 1 ]]; then
    echo "[run-on-cloud] DRY-RUN plan:"
    echo "  ${TOKEN:+VAST_GPU_TARGET=$TOKEN }${CMD[*]}"
    echo "  (no instance provisioned; no charges)"
    exit 0
  fi
  [[ "$PAY" == 1 ]] || die "refusing to provision without --yes-i-will-pay (train runs cost real money — see ../CLOUD_VAST.md)"
  [[ -n "${VAST_API_KEY:-}" || -f "$HOME/.config/vastai/vast_api_key" ]] || die "VAST_API_KEY not set (and no ~/.config/vastai/vast_api_key) — fail-closed"
  exec env ${TOKEN:+VAST_GPU_TARGET="$TOKEN"} "${CMD[@]}"
fi

# --------------------------------------------------------------------------
# kernel-verify / bench — provision a single instance, run, pull, teardown.
[[ "$PROVIDER" == "vast" ]] || die "--task $TASK --provider nebius unsupported in run-on-cloud.sh — kernel-verify/bench currently support vast only (use scripts/lib/backends/nebius.py plus a dedicated branch)"

command -v vastai >/dev/null 2>&1 || die "the 'vastai' CLI is required: pip install --user vastai"
VAST_Q="$(gpu_to_vast_query "$GPU")"

# CUDA build image with a 12.8+ toolkit (needed for Blackwell sm_120 SASS;
# harmless on Hopper/Ampere). vast.ai publishes nvidia/cuda images.
IMAGE="nvidia/cuda:12.8.0-devel-ubuntu24.04"
DISK_GB=80

# The remote bootstrap. Heredoc'd onto the instance and run there.
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
ELIZA_MTP_SKIP_SERVER_STRUCTURED_OUTPUT=1 node packages/app-core/scripts/build-llama-cpp-mtp.mjs --target linux-x64-cuda
make -C packages/inference/verify kernel-contract reference-test
REMOTE
)"

case "$TASK" in
  kernel-verify)
    OUT="$RESULTS_DIR/cuda-linux-${GPU}-${DATE_TAG}.json"
    REMOTE_TASK="$(cat <<REMOTE
make -C packages/inference/verify cuda-verify
make -C packages/inference/verify cuda-verify-fused
${SMOKE_MODEL:+export ELIZA_MTP_SMOKE_MODEL=/workspace/smoke.gguf}
${SMOKE_MODEL:+packages/inference/verify/cuda_runner.sh --report /tmp/cuda-report.json} \
  ${SMOKE_MODEL:+|| true}
${SMOKE_MODEL:+test -f /tmp/cuda-report.json && cp /tmp/cuda-report.json /workspace/cuda-report.json}
# No smoke model -> still emit fixture-parity-only evidence.
${SMOKE_MODEL:+:} || cat > /workspace/cuda-report.json <<'JSON'
{"schemaVersion":1,"runner":"run-on-cloud kernel-verify","status":"pass","passRecordable":false,
 "exitCode":0,"note":"cuda-verify + cuda-verify-fused fixture parity only; no ELIZA_MTP_SMOKE_MODEL → graph smoke skipped, so this is NOT a runtime-ready record. Pass --smoke-model to upgrade."}
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
# e2e CUDA bench harness. The repo bench entrypoint reads the bench_results
# dir; we point it at /workspace and copy out.
ELIZA1_BENCH_TIER=$TIER ELIZA1_BENCH_REGISTRY_KEY=$REG_KEY \
  node packages/inference/verify/eliza1_gates_collect.mjs --backend cuda --bench --out /workspace/bench.json || \
  { echo "bench harness not present on this commit - emitting toolchain-only evidence"; \
    printf "{\"schemaVersion\":1,\"backend\":\"cuda\",\"gpu\":\"%s\",\"tier\":\"%s\",\"status\":\"toolchain-only\",\"note\":\"eliza1 bench harness not on this commit\"}\\n" "$GPU" "$TIER" > /workspace/bench.json; }
cp /workspace/bench.json /workspace/eliza/bench.json 2>/dev/null || true
REMOTE
)"
    PULL_REMOTE="/workspace/bench.json:$OUT /workspace/eliza/bench.json:$OUT"
    mkdir -p "$BENCH_DIR"
    ;;
esac

# --------------------------------------------------------------------------
# Provisioning plan.
echo "[run-on-cloud] === PLAN ==="
echo "  provider     : vast.ai"
echo "  task         : $TASK   tier: $TIER"
echo "  gpu          : $GPU   (vastai filter: $VAST_Q)"
echo "  image        : $IMAGE   disk: ${DISK_GB}GB"
echo "  repo         : $GIT_REMOTE @ $GIT_SHA"
echo "  ssh pubkey   : $SSH_PUBKEY"
echo "  smoke model  : ${SMOKE_MODEL:-<none — graph smoke skipped, parity-only>}"
echo "  results -> $OUT"
echo "[run-on-cloud] ============"

if [[ "$DRYRUN" == 1 ]]; then
  echo "[run-on-cloud] DRY-RUN — no instance provisioned, no charges. Re-run without --dry-run and with --yes-i-will-pay to proceed."
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
printf '%s\n%s\n' "$REMOTE_SCRIPT" "$REMOTE_TASK" \
  | ssh -o StrictHostKeyChecking=no "$SSH_HOSTPORT" "mkdir -p /workspace && cat > /workspace/bootstrap.sh"
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
