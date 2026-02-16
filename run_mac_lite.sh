#!/bin/bash

# Configuration
TASK=${1:-"Write a haiku about AI"}
ITERATIONS=${2:-1}
EPOCHS=${3:-3}

echo "=== MAC LITE RLAIF LOOP ==="
echo "Task: $TASK"
echo "Iterations: $ITERATIONS"
echo "Epochs: $EPOCHS"
echo "==========================="

# 1. Generate (using Mock or Local Model if configured)
# For 'Lite' mode, we'll stick to the default provider but just 1 iteration
echo -e "\n[1/3] Generating Trajectories..."
bun packages/training/scripts/run_task_benchmark.ts --task "$TASK" --iterations $ITERATIONS

# 2. Rank (using Mock to save API costs if needed, or real API)
echo -e "\n[2/3] Ranking Trajectories..."
# Note: This will use OpenAI by default. 
# To use a local LLM runner for ranking, we'd need to update rank_trajectories.ts further.
# For now, we assume the user has a small OpenAI budget or hits the fallback mock.
bun packages/training/scripts/rank_trajectories.ts

# 3. Train (using MLX on Mac)
echo -e "\n[3/3] Training on Apple Silicon (MLX)..."
echo "Model: Qwen2.5-0.5B-Instruct-4bit (Tiny & Fast)"
python3 packages/training/scripts/train_jsonl.py \
    --model mlx-community/Qwen2.5-0.5B-Instruct-4bit \
    --iters $EPOCHS \
    --batch-size 4 \
    --lr 1e-4 \
    --min-score 0.1

echo -e "\n[Done] Model adapters saved to trained_models/jsonl_run"
