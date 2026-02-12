#!/bin/bash
#
# RunPod Validation Script
# 
# Runs a quick validation of the training pipeline on cloud GPUs.
# Expects setup to be complete (run runpod_setup.sh first).
#

set -e

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
RESET='\033[0m'

cd "$(dirname "$0")/.."
source python/venv/bin/activate

echo -e "${CYAN}======================================${RESET}"
echo -e "${CYAN}  Babylon Training - Cloud Validation ${RESET}"
echo -e "${CYAN}======================================${RESET}"
echo ""

# Check GPU count
GPU_COUNT=$(python -c "import torch; print(torch.cuda.device_count())")
echo -e "${GREEN}GPU Count: $GPU_COUNT${RESET}"

# Determine profile based on GPU count
if [ "$GPU_COUNT" -ge 4 ]; then
    PROFILE="l40-4gpu"
    MODEL="Qwen/Qwen3-30B-A3B"
elif [ "$GPU_COUNT" -ge 2 ]; then
    PROFILE="l40-2gpu"
    MODEL="Qwen/Qwen2.5-32B-Instruct"
else
    PROFILE="l40"
    MODEL="Qwen/Qwen2.5-14B-Instruct"
fi

echo -e "${GREEN}Selected profile: $PROFILE${RESET}"
echo -e "${GREEN}Model: $MODEL${RESET}"
echo ""

# Test 1: Quick vLLM model loading
echo -e "${CYAN}[Test 1/4] Testing vLLM model loading...${RESET}"
python -c "
import torch
from vllm import LLM

print('Loading model for inference test...')
llm = LLM(
    model='$MODEL',
    tensor_parallel_size=$GPU_COUNT,
    gpu_memory_utilization=0.5,
    max_model_len=2048,
)
print('✓ Model loaded successfully')

# Quick inference test
outputs = llm.generate(['Hello, I am a trading agent.'], max_tokens=20)
print(f'✓ Inference test passed: {outputs[0].outputs[0].text[:50]}...')
" && echo -e "${GREEN}✓ vLLM test passed${RESET}" || {
    echo -e "${RED}✗ vLLM test failed${RESET}"
    echo -e "${YELLOW}Trying with smaller model...${RESET}"
    
    # Fallback to smaller model
    python -c "
from vllm import LLM
llm = LLM(model='Qwen/Qwen2.5-7B-Instruct', tensor_parallel_size=min($GPU_COUNT, 2), gpu_memory_utilization=0.4, max_model_len=2048)
print('✓ Fallback model loaded')
outputs = llm.generate(['Hello'], max_tokens=10)
print(f'✓ Inference: {outputs[0].outputs[0].text}')
"
    PROFILE="48gb"  # Fall back to smaller profile
}

echo ""

# Test 2: Service manager
echo -e "${CYAN}[Test 2/4] Testing service manager...${RESET}"
cd python
PYTHONPATH=. python -c "
from src.training.service_manager import ServiceConfig, check_prerequisites

config = ServiceConfig(
    model_name='Qwen/Qwen2.5-7B-Instruct',
    tensor_parallel_size=$GPU_COUNT,
    vllm_gpu_memory_utilization=0.4,
)
print(f'✓ ServiceConfig created: tensor_parallel={config.tensor_parallel_size}')

errors = check_prerequisites()
if errors:
    for e in errors:
        print(f'  Warning: {e}')
else:
    print('✓ All prerequisites met')
"
cd ..
echo -e "${GREEN}✓ Service manager test passed${RESET}"
echo ""

# Test 3: Quick training run (10 steps)
echo -e "${CYAN}[Test 3/4] Running quick training validation (10 steps)...${RESET}"
echo -e "${YELLOW}This will take 5-15 minutes depending on model size...${RESET}"
echo ""

# Use a simpler profile for the quick test
make train PROFILE=48gb STEPS=10 2>&1 | tee /tmp/training_validation.log

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ Training validation passed${RESET}"
else
    echo -e "${RED}✗ Training validation failed${RESET}"
    echo -e "Check /tmp/training_validation.log for details"
    exit 1
fi
echo ""

# Test 4: Check trained model output
echo -e "${CYAN}[Test 4/4] Checking trained model output...${RESET}"
if [ -d "python/trained_models/final_model" ]; then
    echo -e "${GREEN}✓ Trained model saved to python/trained_models/final_model${RESET}"
    ls -la python/trained_models/final_model/ | head -10
else
    echo -e "${YELLOW}⚠ No final model found (might be too few steps)${RESET}"
fi
echo ""

echo -e "${GREEN}======================================${RESET}"
echo -e "${GREEN}  Validation Complete!                ${RESET}"
echo -e "${GREEN}======================================${RESET}"
echo ""
echo -e "Cloud training is working. Next steps:"
echo ""
echo -e "  ${CYAN}# Full training run with W&B logging${RESET}"
echo -e "  export WANDB_API_KEY=your_key"
echo -e "  make train-cloud PROFILE=$PROFILE STEPS=1000"
echo ""
echo -e "  ${CYAN}# Or with online training${RESET}"
echo -e "  make bridge-server &"
echo -e "  make train-online PROFILE=$PROFILE STEPS=500"
echo ""



