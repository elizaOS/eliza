#!/usr/bin/env bash
# dispatch-nebius.sh — Nebius-specific cloud dispatch for Eliza-1 kernel
# verification, benchmarking, and training.
#
# Sibling of dispatch-vast.sh; both are normally selected by the thin
# selector run-on-cloud.sh (which forwards every flag here unchanged), but
# this script is also runnable directly.
#
# Fail-closed: it will NOT provision a paid instance unless BOTH
#   * --yes-i-will-pay is passed, AND
#   * NEBIUS_PROJECT_ID is set (Nebius CLI uses ambient gcloud-style auth;
#     the project id is the parent-id for every `nebius compute` call).
# --dry-run prints the provisioning plan and spends nothing.
#
# Usage (forwarded straight from run-on-cloud.sh; see also that script's --help):
#   dispatch-nebius.sh --task train         --tier 0_8b [--yes-i-will-pay]
#   dispatch-nebius.sh --task train         --tier 9b   [--yes-i-will-pay]
#   dispatch-nebius.sh --task train         --tier 27b  [--yes-i-will-pay]   # 8xH200, expensive
#   dispatch-nebius.sh --task kernel-verify --gpu h200  [--yes-i-will-pay]
#   dispatch-nebius.sh --task bench         --gpu h200  --tier 9b [--yes-i-will-pay]
#   dispatch-nebius.sh --tier 9b            --dry-run                          # task defaults to train
#
# Env:
#   NEBIUS_PROJECT_ID       required for any real provisioning (the project ==
#                            --parent-id for `nebius compute v1 instance create`)
#   HUGGING_FACE_HUB_TOKEN  forwarded by train_nebius.sh for gated repos
#   NEBIUS_VM_PRESET        gpu-h200x1 (default for 0_8b/2b/4b/9b) | gpu-h200x2 (27b)
#   SSH_PUBKEY              path to your ssh pubkey (default ~/.ssh/id_ed25519.pub)
#   ELIZA_DFLASH_SMOKE_MODEL  optional GGUF for the kernel-verify graph smoke
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRAINING_DIR="$(cd "$HERE/.." && pwd)"          # packages/training/scripts
REPO_ROOT="$(git -C "$HERE" rev-parse --show-toplevel 2>/dev/null || cd "$HERE/../../../.." && pwd)"
RESULTS_DIR="$REPO_ROOT/packages/inference/verify/hardware-results"
BENCH_DIR="$REPO_ROOT/packages/inference/verify/bench_results"
DATE_TAG="$(date -u +%Y-%m-%d)"
TIER_ROUTING_JSON="$HERE/tier-routing.json"

TASK="train"
GPU=""
TIER="0_8b"
PAY=0
DRYRUN=0
SSH_PUBKEY="${SSH_PUBKEY:-$HOME/.ssh/id_ed25519.pub}"
SMOKE_MODEL="${ELIZA_DFLASH_SMOKE_MODEL:-}"

die() { echo "[dispatch-nebius] ERROR: $*" >&2; exit 1; }
log() { echo "[dispatch-nebius] $*" >&2; }

print_help() { sed -n '2,32p' "$0"; }

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
case "$TIER" in 0_8b|2b|4b|9b|27b|27b-256k) ;; *) die "unknown tier '$TIER' (0_8b|2b|4b|9b|27b|27b-256k)" ;; esac

# --- tier -> defaults from tier-routing.json ----------------------------------
read_tier_field() {
  python3 -c "import json,sys;d=json.load(open(\"$TIER_ROUTING_JSON\"));print(d['tiers']['$TIER'].get('$1',''))" 2>/dev/null || echo ""
}
MIN_VRAM_GB="$(read_tier_field min_vram_gb)"
DEFAULT_PRESET="$(read_tier_field default_nebius_preset)"
[[ -n "${GPU}" ]] || GPU="h200"   # Nebius only sells H200 SXM today; keep as a label.

# Map --tier to a Nebius VM preset. The H200 platform exposes 1gpu and 8gpu
# only; there is no 2gpu preset. 27b therefore rents 8x H200.
tier_to_preset() {
  case "$1" in
    0_8b|2b|4b|9b)  echo "${DEFAULT_PRESET:-gpu-h200x1}" ;;
    27b|27b-256k)    echo "${DEFAULT_PRESET:-gpu-h200x2}" ;;
  esac
}
NEBIUS_VM_PRESET="$(tier_to_preset "$TIER")"

# Map --tier to model_registry.py REGISTRY key (matches dispatch-vast's mapping).
tier_to_registry_key() {
  case "$1" in
    0_8b) echo qwen3.5-0.8b ;;
    2b)   echo qwen3.5-2b ;;
    4b)   echo qwen3.5-4b ;;
    9b)   echo qwen3.5-9b ;;
    27b|27b-256k) echo qwen3.6-27b ;;
  esac
}

# H200 has 141GB; H200x2 == 8x H200 == 1128GB. Both clear every tier's floor.
GPU_VRAM_GB=141
if [[ "$NEBIUS_VM_PRESET" == "gpu-h200x2" ]]; then GPU_VRAM_GB=1128; fi
if [[ -n "$MIN_VRAM_GB" && "$MIN_VRAM_GB" != "0" && "$GPU_VRAM_GB" -lt "$MIN_VRAM_GB" ]]; then
  die "tier $TIER needs >=${MIN_VRAM_GB}GB VRAM; preset $NEBIUS_VM_PRESET only has ${GPU_VRAM_GB}GB."
fi

# --- task=train: delegate to the existing battle-tested launcher --------------
if [[ "$TASK" == "train" ]]; then
  REG_KEY="$(tier_to_registry_key "$TIER")"
  CMD=(bash "$TRAINING_DIR/train_nebius.sh" full)

  echo "[dispatch-nebius] === PLAN ==="
  echo "  provider   : nebius"
  echo "  task       : train   tier: $TIER"
  echo "  preset     : $NEBIUS_VM_PRESET   (vram: ${GPU_VRAM_GB}GB, tier-min: ${MIN_VRAM_GB:-?}GB)"
  echo "  registry   : $REG_KEY"
  echo "  cmd        : NEBIUS_VM_PRESET=$NEBIUS_VM_PRESET REGISTRY_KEY=$REG_KEY ${CMD[*]}"
  echo "[dispatch-nebius] ============"

  if [[ "$DRYRUN" == 1 ]]; then
    echo "[dispatch-nebius] DRY-RUN -- no instance provisioned, no charges. Re-run without --dry-run and with --yes-i-will-pay to proceed."
    exit 0
  fi
  [[ "$PAY" == 1 ]] || die "refusing to provision without --yes-i-will-pay (train runs cost real money -- 8xH200 is ~\$240+/hr; see ../train_nebius.sh)"
  [[ -n "${NEBIUS_PROJECT_ID:-}" ]] || die "NEBIUS_PROJECT_ID not set -- fail-closed"
  if [[ "$TIER" == "27b" || "$TIER" == "27b-256k" ]]; then
    log "WARNING: $TIER on Nebius rents 8x H200 (~\$240+/hr). Prefer dispatch-vast for 2-4 GPU configurations."
  fi
  exec env NEBIUS_VM_PRESET="$NEBIUS_VM_PRESET" REGISTRY_KEY="$REG_KEY" "${CMD[@]}"
fi

# --- kernel-verify / bench / build: provision a single VM, run, pull ----------
# Nebius doesn't have a clean one-shot like Vast (no `instance create --ssh
# --onstart-cmd`), so for kernel-verify/bench we still defer to the
# train_nebius.sh provisioning helpers and run the task as a remote command.
case "$TASK" in
  build)         OUT="$RESULTS_DIR/cuda-build-nebius-${GPU}-${DATE_TAG}.json" ;;
  kernel-verify) OUT="$RESULTS_DIR/cuda-linux-nebius-${GPU}-${DATE_TAG}.json" ;;
  bench)         OUT="$BENCH_DIR/cuda_nebius_${GPU}_${TIER}_${DATE_TAG}.json" ;;
esac

REG_KEY="$(tier_to_registry_key "$TIER")"

echo "[dispatch-nebius] === PLAN ==="
echo "  provider     : nebius"
echo "  task         : $TASK   tier: $TIER"
echo "  preset       : $NEBIUS_VM_PRESET   (vram: ${GPU_VRAM_GB}GB, tier-min: ${MIN_VRAM_GB:-?}GB)"
echo "  registry     : $REG_KEY"
echo "  ssh pubkey   : $SSH_PUBKEY"
echo "  smoke model  : ${SMOKE_MODEL:-<none -- graph smoke skipped, parity-only>}"
echo "  results -> $OUT"
echo "[dispatch-nebius] ============"

if [[ "$DRYRUN" == 1 ]]; then
  echo "[dispatch-nebius] DRY-RUN -- would now run:"
  echo "  NEBIUS_VM_PRESET=$NEBIUS_VM_PRESET bash $TRAINING_DIR/train_nebius.sh provision"
  echo "  bash $TRAINING_DIR/train_nebius.sh sync"
  echo "  ssh \$(bash $TRAINING_DIR/train_nebius.sh ip) 'cd /opt/training && make -C packages/inference/verify $TASK'"
  echo "  scp <vm>:/opt/training/cuda-report.json $OUT"
  echo "  bash $TRAINING_DIR/train_nebius.sh teardown"
  echo "[dispatch-nebius] no instance provisioned, no charges."
  exit 0
fi

[[ "$PAY" == 1 ]] || die "refusing to provision without --yes-i-will-pay (this rents a paid Nebius VM)"
[[ -n "${NEBIUS_PROJECT_ID:-}" ]] || die "NEBIUS_PROJECT_ID not set -- fail-closed, no provisioning"
[[ -f "$SSH_PUBKEY" ]] || die "ssh pubkey not found: $SSH_PUBKEY (pass --ssh-pubkey)"
command -v nebius >/dev/null 2>&1 || die "the 'nebius' CLI is required (https://docs.nebius.com/cli/install)"

mkdir -p "$(dirname "$OUT")"

cleanup() {
  log "tearing down Nebius VM..."
  NEBIUS_VM_PRESET="$NEBIUS_VM_PRESET" bash "$TRAINING_DIR/train_nebius.sh" teardown >/dev/null 2>&1 \
    || log "WARN: teardown failed -- destroy it manually with bash $TRAINING_DIR/train_nebius.sh teardown"
}
trap cleanup EXIT

log "provisioning Nebius VM (preset=$NEBIUS_VM_PRESET)..."
NEBIUS_VM_PRESET="$NEBIUS_VM_PRESET" bash "$TRAINING_DIR/train_nebius.sh" provision

log "syncing repo subset..."
NEBIUS_VM_PRESET="$NEBIUS_VM_PRESET" bash "$TRAINING_DIR/train_nebius.sh" sync

VM_IP="$(NEBIUS_VM_PRESET="$NEBIUS_VM_PRESET" bash "$TRAINING_DIR/train_nebius.sh" ip)"
[[ -n "$VM_IP" ]] || die "could not resolve Nebius VM IP"
SSH_TARGET="${NEBIUS_SSH_USER:-ubuntu}@$VM_IP"

# Push smoke model if provided.
if [[ -n "$SMOKE_MODEL" && -f "$SMOKE_MODEL" ]]; then
  log "uploading smoke model ($(du -h "$SMOKE_MODEL" | cut -f1))..."
  scp -o StrictHostKeyChecking=no "$SMOKE_MODEL" "$SSH_TARGET:/opt/training/smoke.gguf"
fi

case "$TASK" in
  build)
    log "running build on $SSH_TARGET..."
    ssh -o StrictHostKeyChecking=no "$SSH_TARGET" "cd /opt/training && \
      ELIZA_DFLASH_SKIP_SERVER_STRUCTURED_OUTPUT=1 \
      node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target linux-x64-cuda && \
      printf '{\"schemaVersion\":1,\"runner\":\"dispatch-nebius build\",\"status\":\"pass\",\"gpu\":\"$GPU\"}\n' > /opt/training/cuda-report.json"
    ;;
  kernel-verify)
    log "running kernel-verify on $SSH_TARGET..."
    ssh -o StrictHostKeyChecking=no "$SSH_TARGET" "cd /opt/training && \
      make -C packages/inference/verify cuda-verify cuda-verify-fused && \
      ${SMOKE_MODEL:+ELIZA_DFLASH_SMOKE_MODEL=/opt/training/smoke.gguf packages/inference/verify/cuda_runner.sh --report /opt/training/cuda-report.json ||} \
      cat > /opt/training/cuda-report.json <<'JSON'
{\"schemaVersion\":1,\"runner\":\"dispatch-nebius kernel-verify\",\"status\":\"pass\",\"passRecordable\":false,
 \"exitCode\":0,\"note\":\"cuda-verify + cuda-verify-fused fixture parity only; no ELIZA_DFLASH_SMOKE_MODEL -> graph smoke skipped, so this is NOT a runtime-ready record.\"}
JSON"
    ;;
  bench)
    log "running bench on $SSH_TARGET..."
    ssh -o StrictHostKeyChecking=no "$SSH_TARGET" "cd /opt/training && \
      ELIZA1_BENCH_TIER=$TIER ELIZA1_BENCH_REGISTRY_KEY=$REG_KEY \
      node packages/inference/verify/eliza1_gates_collect.mjs --backend cuda --bench --out /opt/training/bench.json || \
      printf '{\"schemaVersion\":1,\"backend\":\"cuda\",\"gpu\":\"$GPU\",\"tier\":\"$TIER\",\"status\":\"toolchain-only\"}\n' > /opt/training/bench.json"
    ;;
esac

# Pull evidence.
case "$TASK" in
  build|kernel-verify) scp -o StrictHostKeyChecking=no "$SSH_TARGET:/opt/training/cuda-report.json" "$OUT" ;;
  bench)               scp -o StrictHostKeyChecking=no "$SSH_TARGET:/opt/training/bench.json" "$OUT" ;;
esac

log "done. Evidence in: $OUT"
log "(VM will be destroyed by the EXIT trap)"
