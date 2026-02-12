#!/bin/bash
#
# RunPod Setup Script for Babylon Training
# 
# Usage:
#   1. SSH into your RunPod instance
#   2. Clone the repo
#   3. Run: bash packages/training/scripts/runpod_setup.sh
#
# Prerequisites:
#   - 2x L40 GPUs (96GB total VRAM)
#   - WANDB_API_KEY environment variable (optional)
#   - DATABASE_URL for trajectory data (or use synthetic)
#

set -e

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
RESET='\033[0m'

echo -e "${CYAN}======================================${RESET}"
echo -e "${CYAN}  Babylon Training - RunPod Setup    ${RESET}"
echo -e "${CYAN}======================================${RESET}"
echo ""

# Check GPU availability
echo -e "${CYAN}[1/7] Checking GPU availability...${RESET}"
if command -v nvidia-smi &> /dev/null; then
    GPU_COUNT=$(nvidia-smi --query-gpu=name --format=csv,noheader | wc -l)
    echo -e "${GREEN}✓ Found $GPU_COUNT GPU(s):${RESET}"
    nvidia-smi --query-gpu=name,memory.total --format=csv
else
    echo -e "${RED}✗ nvidia-smi not found. GPU drivers not installed?${RESET}"
    exit 1
fi

# Navigate to training directory
cd "$(dirname "$0")/.."
TRAINING_DIR=$(pwd)
echo -e "${GREEN}✓ Working directory: $TRAINING_DIR${RESET}"

# Install system dependencies
echo ""
echo -e "${CYAN}[2/7] Installing system dependencies...${RESET}"
apt-get update -qq
apt-get install -y -qq python3.11 python3.11-venv python3-pip curl git > /dev/null 2>&1
echo -e "${GREEN}✓ System dependencies installed${RESET}"

# Create virtual environment
echo ""
echo -e "${CYAN}[3/7] Setting up Python virtual environment...${RESET}"
cd python
if [ ! -d "venv" ]; then
    python3.11 -m venv venv
fi
source venv/bin/activate
pip install --upgrade pip -q
echo -e "${GREEN}✓ Virtual environment activated${RESET}"

# Install Python dependencies
echo ""
echo -e "${CYAN}[4/7] Installing Python dependencies (this may take 5-10 minutes)...${RESET}"
pip install -r requirements.txt -q
pip install vllm>=0.4.0 atroposlib wandb -q
echo -e "${GREEN}✓ Python dependencies installed${RESET}"

# Try to install flash-attention (optional, may fail on some systems)
echo ""
echo -e "${CYAN}[5/7] Installing flash-attention (optional)...${RESET}"
pip install flash-attn --no-build-isolation -q 2>/dev/null && \
    echo -e "${GREEN}✓ Flash attention installed${RESET}" || \
    echo -e "${YELLOW}⚠ Flash attention not available (optional, continuing)${RESET}"

# Verify installation
echo ""
echo -e "${CYAN}[6/7] Verifying installation...${RESET}"
python -c "
import torch
import vllm
print(f'PyTorch: {torch.__version__}')
print(f'CUDA available: {torch.cuda.is_available()}')
print(f'GPU count: {torch.cuda.device_count()}')
for i in range(torch.cuda.device_count()):
    props = torch.cuda.get_device_properties(i)
    print(f'  GPU {i}: {props.name} ({props.total_memory / 1e9:.1f} GB)')
print(f'vLLM: {vllm.__version__}')
"
echo -e "${GREEN}✓ Installation verified${RESET}"

# Setup environment
echo ""
echo -e "${CYAN}[7/7] Setting up environment...${RESET}"

# Check for W&B key
if [ -n "$WANDB_API_KEY" ]; then
    echo -e "${GREEN}✓ W&B API key found${RESET}"
else
    echo -e "${YELLOW}⚠ WANDB_API_KEY not set. Set it with: export WANDB_API_KEY=your_key${RESET}"
fi

# Check for database
if [ -n "$DATABASE_URL" ]; then
    echo -e "${GREEN}✓ DATABASE_URL found${RESET}"
else
    echo -e "${YELLOW}⚠ DATABASE_URL not set. Will use synthetic data for online training.${RESET}"
fi

echo ""
echo -e "${GREEN}======================================${RESET}"
echo -e "${GREEN}  Setup Complete!                     ${RESET}"
echo -e "${GREEN}======================================${RESET}"
echo ""
echo -e "Next steps:"
echo ""
echo -e "  ${CYAN}# Activate environment${RESET}"
echo -e "  source python/venv/bin/activate"
echo ""
echo -e "  ${CYAN}# Quick validation (single GPU, small model)${RESET}"
echo -e "  make train PROFILE=48gb STEPS=20"
echo ""
echo -e "  ${CYAN}# 2x L40 validation (14B model)${RESET}"
echo -e "  make train PROFILE=l40-2gpu STEPS=50"
echo ""
echo -e "  ${CYAN}# Full cloud training with W&B${RESET}"
echo -e "  export WANDB_API_KEY=your_key"
echo -e "  make train-cloud PROFILE=l40-2gpu STEPS=100"
echo ""
echo -e "  ${CYAN}# Online training (requires bridge server)${RESET}"
echo -e "  # Terminal 1: make bridge-server"
echo -e "  # Terminal 2: make train-online PROFILE=l40-2gpu"
echo ""



