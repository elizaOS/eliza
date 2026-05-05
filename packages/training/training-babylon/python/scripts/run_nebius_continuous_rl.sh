#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Run Continuous RL Training on Nebius GPU Instance
#
# This script:
#   1. Syncs code to a Nebius VM (H100/H200)
#   2. Sets up the Python environment
#   3. Runs shared-model continuous RL with Kondo gate + APOLLO + TurboQuant
#   4. Periodically evaluates on ScamBench
#   5. Downloads checkpoints and results
#
# Prerequisites:
#   - nebius CLI authenticated (nebius iam get-access-token)
#   - SSH key configured for Nebius
#   - GPU VM provisioned (or use --provision to auto-create)
#
# Usage:
#   # With existing Nebius VM
#   ./scripts/run_nebius_continuous_rl.sh --host <IP> --user <USER>
#
#   # Quick local test (mock bridge, no GPU server needed)
#   ./scripts/run_nebius_continuous_rl.sh --local --mock
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# Defaults
HOST=""
USER="ubuntu"
MODEL="Qwen/Qwen3-4B"
TICKS=200
AGENTS_PER_TEAM=10
KONDO_RATE=0.03
LOCAL=false
MOCK=false
EVAL_EVERY=50
REMOTE_DIR="/home/\$USER/babylon-rl"

usage() {
  echo "Usage: $0 [OPTIONS]"
  echo ""
  echo "Options:"
  echo "  --host HOST          Nebius VM IP address"
  echo "  --user USER          SSH username (default: ubuntu)"
  echo "  --model MODEL        Model name (default: Qwen/Qwen3-4B)"
  echo "  --ticks N            Training ticks (default: 200)"
  echo "  --agents N           Agents per team (default: 10)"
  echo "  --kondo-rate R       Kondo gate rate (default: 0.03)"
  echo "  --eval-every N       ScamBench eval interval (default: 50)"
  echo "  --local              Run locally instead of remote"
  echo "  --mock               Use mock bridge (no game server)"
  exit 1
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --host) HOST="$2"; shift 2 ;;
    --user) USER="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --ticks) TICKS="$2"; shift 2 ;;
    --agents) AGENTS_PER_TEAM="$2"; shift 2 ;;
    --kondo-rate) KONDO_RATE="$2"; shift 2 ;;
    --eval-every) EVAL_EVERY="$2"; shift 2 ;;
    --local) LOCAL=true; shift ;;
    --mock) MOCK=true; shift ;;
    *) usage ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TRAINING_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BABYLON_ROOT="$(cd "$TRAINING_ROOT/../.." && pwd)"
SCAMBENCH_ROOT="$(cd "$BABYLON_ROOT/../scambench" && pwd)"

echo "═══════════════════════════════════════════════════════════════════"
echo "  Babylon Continuous RL Training"
echo "═══════════════════════════════════════════════════════════════════"
echo "  Model:           $MODEL"
echo "  Ticks:           $TICKS"
echo "  Agents/team:     $AGENTS_PER_TEAM"
echo "  Kondo gate:      $KONDO_RATE"
echo "  Eval every:      $EVAL_EVERY ticks"
echo "  Mode:            $(if $LOCAL; then echo 'LOCAL'; else echo "REMOTE ($HOST)"; fi)"
echo "  Bridge:          $(if $MOCK; then echo 'MOCK'; else echo 'LIVE'; fi)"
echo "═══════════════════════════════════════════════════════════════════"

if $LOCAL; then
  # ── Local mode ───────────────────────────────────────────────────────
  echo ""
  echo "[1/3] Running shared-model continuous RL locally..."
  cd "$TRAINING_ROOT"

  MOCK_FLAG=""
  if $MOCK; then MOCK_FLAG="--mock"; fi

  python3 scripts/run_shared_model_rl.py \
    $MOCK_FLAG \
    --model "$MODEL" \
    --device cuda \
    --ticks "$TICKS" \
    --agents-per-team "$AGENTS_PER_TEAM" \
    --kondo-rate "$KONDO_RATE" \
    --checkpoint-every "$EVAL_EVERY" \
    --log-every 5 \
    --output "./continuous_rl_results.json"

  echo ""
  echo "[2/3] Evaluating on ScamBench (deterministic)..."
  cd "$SCAMBENCH_ROOT"
  bun run src/index.ts \
    --scenario-limit 50 \
    --output-dir ./results/continuous-rl-eval \
    --score-attacker

  echo ""
  echo "[3/3] Done. Results:"
  echo "  Training: $TRAINING_ROOT/continuous_rl_results.json"
  echo "  ScamBench: $SCAMBENCH_ROOT/results/continuous-rl-eval/"

else
  # ── Remote mode (Nebius) ─────────────────────────────────────────────
  if [[ -z "$HOST" ]]; then
    echo "ERROR: --host is required for remote mode"
    usage
  fi

  echo ""
  echo "[1/5] Syncing code to $HOST..."
  ssh "$USER@$HOST" "mkdir -p $REMOTE_DIR"

  rsync -avz --delete \
    --exclude '.git' \
    --exclude 'node_modules' \
    --exclude '.next' \
    --exclude '__pycache__' \
    --exclude '*.pyc' \
    --exclude 'venv' \
    --exclude '.turbo' \
    --exclude 'dist' \
    "$TRAINING_ROOT/" "$USER@$HOST:$REMOTE_DIR/training/"

  rsync -avz --delete \
    --exclude '.git' \
    --exclude 'node_modules' \
    --exclude '__pycache__' \
    "$SCAMBENCH_ROOT/src/" "$USER@$HOST:$REMOTE_DIR/scambench/src/"

  echo ""
  echo "[2/5] Setting up Python environment..."
  ssh "$USER@$HOST" << 'SETUP_EOF'
cd $HOME/babylon-rl/training
python3 -m venv venv 2>/dev/null || true
source venv/bin/activate
pip install -q torch transformers accelerate
pip install -q apollo-torch kondo-gate aiohttp
echo "Python environment ready"
SETUP_EOF

  echo ""
  echo "[3/5] Starting continuous RL training on Nebius GPU..."
  MOCK_FLAG=""
  if $MOCK; then MOCK_FLAG="--mock"; fi

  ssh "$USER@$HOST" << TRAIN_EOF
cd \$HOME/babylon-rl/training
source venv/bin/activate
python3 scripts/run_shared_model_rl.py \
  $MOCK_FLAG \
  --model "$MODEL" \
  --device cuda \
  --ticks $TICKS \
  --agents-per-team $AGENTS_PER_TEAM \
  --kondo-rate $KONDO_RATE \
  --checkpoint-every $EVAL_EVERY \
  --log-every 5 \
  --output "./continuous_rl_results.json"
TRAIN_EOF

  echo ""
  echo "[4/5] Downloading results..."
  mkdir -p "$TRAINING_ROOT/nebius-results"
  rsync -avz "$USER@$HOST:$REMOTE_DIR/training/continuous_rl_results.json" \
    "$TRAINING_ROOT/nebius-results/"
  rsync -avz "$USER@$HOST:$REMOTE_DIR/training/shared_model_checkpoints/" \
    "$TRAINING_ROOT/nebius-results/checkpoints/" 2>/dev/null || true

  echo ""
  echo "[5/5] Done. Results downloaded to:"
  echo "  $TRAINING_ROOT/nebius-results/"
fi
