#!/usr/bin/env bash
# Stage-2 GRPO training with ByteDance verl and its vLLM rollout backend.
#
# Per RL_STRATEGY.md: input = SFT-then-DPO checkpoint, output = -rl-v1
# checkpoint, reward = scripts/eliza_reward_fn.py:compute_score (verl's
# `reward_score.compute_score` registry signature).
#
# Hardware budgets (from RL_STRATEGY.md "Hardware + cost"):
#   2b   → 2× H200 (1 train + 1 rollout)            ~24h
#   9b   → 4× H200 (1 train + 3 rollout shards)     ~24-48h
#   27b  → 8× H200 (4 train + 4 rollout)            ~48h
#
# Usage:
#   uv run --locked --extra rl bash scripts/train_grpo_verl.sh \
#       --registry-key gemma4-e4b \
#       --dpo-checkpoint checkpoints/eliza-1-4b-dpo/final \
#       --output-dir checkpoints/eliza-1-4b-grpo \
#       --rollouts 64 --rollout-batch 8 --epochs 1
#
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: train_grpo_verl.sh [options]

Required:
  --registry-key KEY        e.g. gemma4-e2b, gemma4-e4b, gemma4-12b, gemma4-31b
  --dpo-checkpoint DIR      Path to SFT+DPO checkpoint (the `final/` subdir)
  --output-dir DIR          Where to write the GRPO checkpoint + JSONL traces

Optional:
  --rollouts N              Group size K per prompt (default 8 — DeepSeek's GRPO default)
  --rollout-batch N         Prompts per rollout step (default 8)
  --epochs F                PPO/GRPO epochs over the rollout buffer (default 1)
  --train-file PATH         Prompt JSONL for rollouts (default: data/final/test.jsonl)
  --kl-coef F               KL penalty vs ref policy (default 0.001 — verl default)
  --max-response-len N      Max generated tokens per rollout (default 1024)
  --gpus N                  Total GPUs available on this node (default: nvidia-smi count)
  --help                    Show this message
EOF
}

REGISTRY_KEY=""
DPO_CKPT=""
OUTPUT_DIR=""
ROLLOUTS=8
ROLLOUT_BATCH=8
EPOCHS=1
TRAIN_FILE=""
KL_COEF=0.001
MAX_RESPONSE_LEN=1024
GPUS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --registry-key) REGISTRY_KEY="$2"; shift 2;;
    --dpo-checkpoint) DPO_CKPT="$2"; shift 2;;
    --output-dir) OUTPUT_DIR="$2"; shift 2;;
    --rollouts) ROLLOUTS="$2"; shift 2;;
    --rollout-batch) ROLLOUT_BATCH="$2"; shift 2;;
    --epochs) EPOCHS="$2"; shift 2;;
    --train-file) TRAIN_FILE="$2"; shift 2;;
    --kl-coef) KL_COEF="$2"; shift 2;;
    --max-response-len) MAX_RESPONSE_LEN="$2"; shift 2;;
    --gpus) GPUS="$2"; shift 2;;
    -h|--help) usage; exit 0;;
    *) echo "Unknown arg: $1" >&2; usage >&2; exit 2;;
  esac
done

if [[ -z "$REGISTRY_KEY" || -z "$DPO_CKPT" || -z "$OUTPUT_DIR" ]]; then
  echo "ERROR: --registry-key, --dpo-checkpoint, --output-dir are required" >&2
  usage >&2
  exit 2
fi

THIS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRAIN_ROOT="$(cd "$THIS_DIR/.." && pwd)"

if [[ -z "$TRAIN_FILE" ]]; then
  TRAIN_FILE="$TRAIN_ROOT/data/final/test.jsonl"
fi

if [[ ! -d "$DPO_CKPT" ]]; then
  echo "ERROR: dpo-checkpoint not found: $DPO_CKPT" >&2
  exit 1
fi
if [[ ! -f "$TRAIN_FILE" ]]; then
  echo "ERROR: train-file not found: $TRAIN_FILE" >&2
  exit 1
fi

PYTHON_BIN="$(command -v python3 || true)"
if [[ -z "$PYTHON_BIN" ]] || ! "$PYTHON_BIN" -c "import ray, verl, vllm" >/dev/null 2>&1; then
  echo "ERROR: the locked verl/vLLM RL runtime is not active." >&2
  echo "Run this launcher through uv from $TRAIN_ROOT:" >&2
  echo "  uv run --locked --extra rl bash scripts/train_grpo_verl.sh ..." >&2
  exit 1
fi

# Resolve every path without creating the output directory. Config composition
# and verl's own validator must succeed before this launcher writes run state.
DPO_CKPT="$("$PYTHON_BIN" -c 'from pathlib import Path; import sys; print(Path(sys.argv[1]).resolve())' "$DPO_CKPT")"
TRAIN_FILE="$("$PYTHON_BIN" -c 'from pathlib import Path; import sys; print(Path(sys.argv[1]).resolve())' "$TRAIN_FILE")"
OUTPUT_DIR="$("$PYTHON_BIN" -c 'from pathlib import Path; import sys; print(Path(sys.argv[1]).resolve())' "$OUTPUT_DIR")"

if [[ -z "$GPUS" ]]; then
  if command -v nvidia-smi >/dev/null 2>&1; then
    GPUS="$(nvidia-smi --query-gpu=name --format=csv,noheader | wc -l)"
  else
    GPUS=1
  fi
fi

CFG_PATH="$OUTPUT_DIR/verl_config.yaml"
INSTR_PATH="$OUTPUT_DIR/instrumentation.jsonl"
VERL_DATASET_PATH="$OUTPUT_DIR/verl_train.jsonl"
REWARD_FUNCTION_PATH="$TRAIN_ROOT/scripts/eliza_reward_fn.py"

CONFIG_WORK_DIR="$(mktemp -d)"
cleanup_config_work_dir() {
  rm -rf "$CONFIG_WORK_DIR"
}
trap cleanup_config_work_dir EXIT
TEMP_DATASET="$CONFIG_WORK_DIR/verl_train.jsonl"
TEMP_CONFIG="$CONFIG_WORK_DIR/verl_config.yaml"

"$PYTHON_BIN" "$TRAIN_ROOT/scripts/prepare_grpo_verl_dataset.py" \
  --source "$TRAIN_FILE" \
  --output "$TEMP_DATASET"

# Ask the installed pinned verl entry point to compose its complete Hydra tree.
# The resulting file includes upstream actor/critic/reward/Ray defaults plus our
# explicit GRPO overrides, so the exact config validated here is the one run.
VERL_OVERRIDES=(
  "algorithm.adv_estimator=grpo"
  "algorithm.use_kl_in_reward=False"
  "data.train_files=[\"$VERL_DATASET_PATH\"]"
  "data.val_files=[\"$VERL_DATASET_PATH\"]"
  "data.prompt_key=prompt"
  "data.max_prompt_length=2048"
  "data.max_response_length=$MAX_RESPONSE_LEN"
  "data.train_batch_size=$ROLLOUT_BATCH"
  "data.filter_overlong_prompts=True"
  "actor_rollout_ref.model.path=$DPO_CKPT"
  "actor_rollout_ref.model.use_remove_padding=True"
  "actor_rollout_ref.model.enable_gradient_checkpointing=True"
  "actor_rollout_ref.actor.optim.lr=1e-6"
  "actor_rollout_ref.actor.ppo_mini_batch_size=$ROLLOUT_BATCH"
  "actor_rollout_ref.actor.ppo_micro_batch_size_per_gpu=1"
  "actor_rollout_ref.actor.use_dynamic_bsz=True"
  "actor_rollout_ref.actor.use_kl_loss=True"
  "actor_rollout_ref.actor.kl_loss_coef=$KL_COEF"
  "actor_rollout_ref.actor.fsdp_config.param_offload=False"
  "actor_rollout_ref.actor.fsdp_config.optimizer_offload=False"
  "actor_rollout_ref.rollout.name=vllm"
  "actor_rollout_ref.rollout.n=$ROLLOUTS"
  "actor_rollout_ref.rollout.gpu_memory_utilization=0.6"
  "actor_rollout_ref.rollout.tensor_model_parallel_size=1"
  "actor_rollout_ref.rollout.log_prob_micro_batch_size_per_gpu=1"
  "actor_rollout_ref.ref.fsdp_config.param_offload=True"
  "actor_rollout_ref.ref.log_prob_micro_batch_size_per_gpu=1"
  "critic.enable=False"
  "reward.reward_model.enable=False"
  "reward.custom_reward_function.path=$REWARD_FUNCTION_PATH"
  "reward.custom_reward_function.name=compute_score"
  "trainer.total_epochs=$EPOCHS"
  "trainer.project_name=eliza-1-grpo"
  "trainer.experiment_name=$(basename "$OUTPUT_DIR")"
  "trainer.default_local_dir=$OUTPUT_DIR"
  "trainer.n_gpus_per_node=$GPUS"
  "trainer.nnodes=1"
  "trainer.save_freq=100"
  "trainer.test_freq=50"
  "trainer.val_before_train=False"
  "trainer.logger=[console]"
)

"$PYTHON_BIN" -m verl.trainer.main_ppo --cfg job --resolve \
  "${VERL_OVERRIDES[@]}" > "$TEMP_CONFIG"
"$PYTHON_BIN" "$TRAIN_ROOT/scripts/validate_grpo_verl_config.py" \
  --config "$TEMP_CONFIG" \
  --prepared-dataset "$TEMP_DATASET" \
  --configured-dataset "$VERL_DATASET_PATH" \
  --checkpoint "$DPO_CKPT" \
  --reward-function "$REWARD_FUNCTION_PATH" \
  --rollouts "$ROLLOUTS" \
  --rollout-batch "$ROLLOUT_BATCH" \
  --epochs "$EPOCHS" \
  --kl-coef "$KL_COEF" \
  --gpus "$GPUS"

mkdir -p "$OUTPUT_DIR"
mv "$TEMP_DATASET" "$VERL_DATASET_PATH"
mv "$TEMP_CONFIG" "$CFG_PATH"

# Dump environment record matching the SFT/DPO instrumentation schema so the
# UI's plot pipeline consumes all three stages uniformly.
"$PYTHON_BIN" - <<PY > /dev/null
import json, os, platform, time
from pathlib import Path
out = Path("$OUTPUT_DIR")
out.mkdir(parents=True, exist_ok=True)
(out / "environment.json").write_text(json.dumps({
    "platform": platform.platform(),
    "python": platform.python_version(),
    "cwd": os.getcwd(),
    "run_meta": {
        "stage": "grpo",
        "registry_key": "$REGISTRY_KEY",
        "dpo_checkpoint": "$DPO_CKPT",
        "rollouts": $ROLLOUTS,
        "rollout_batch": $ROLLOUT_BATCH,
        "epochs": $EPOCHS,
        "kl_coef": $KL_COEF,
        "max_response_len": $MAX_RESPONSE_LEN,
        "gpus": $GPUS,
    },
    "timestamp": time.time(),
}, indent=2))
# Seed the JSONL trace with a train_begin event so downstream readers don't
# choke on an empty file before verl's first reward log lands.
with (out / "instrumentation.jsonl").open("a") as f:
    f.write(json.dumps({
        "event": "train_begin",
        "stage": "grpo",
        "config": {"registry_key": "$REGISTRY_KEY", "rollouts": $ROLLOUTS,
                   "rollout_batch": $ROLLOUT_BATCH, "epochs": $EPOCHS,
                   "kl_coef": $KL_COEF, "gpus": $GPUS},
    }) + "\n")
PY

echo "validated verl config written: $CFG_PATH"
echo "prepared verl dataset: $VERL_DATASET_PATH"
echo "instrumentation jsonl: $INSTR_PATH"
echo "GPUs detected/used: $GPUS"

# Make eliza_reward_fn importable as a top-level module path. verl resolves
# `custom_reward_function.path` directly so this is mostly belt-and-braces
# for the data-loader workers.
export PYTHONPATH="$TRAIN_ROOT/scripts:${PYTHONPATH:-}"

trap - EXIT
cleanup_config_work_dir

exec "$PYTHON_BIN" -m verl.trainer.main_ppo \
  --config-path "$(dirname "$CFG_PATH")" \
  --config-name "$(basename "$CFG_PATH" .yaml)"
