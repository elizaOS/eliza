#!/usr/bin/env bash
# Run once inside the Nebius H200 container to set up the training environment.
# Tested against nvcr.io/nvidia/pytorch:25.01-py3 (CUDA 12.4).
#
# Usage:
#   bash container_setup.sh
#
# This script is idempotent: re-running it after a partial install is safe.
set -euo pipefail

log() {
  printf '[container_setup] %s\n' "$*"
}

log "Installing uv..."
pip install --quiet --upgrade uv

log "Installing PyTorch (cu124) via uv..."
uv pip install --quiet \
  torch \
  torchvision \
  --index-url https://download.pytorch.org/whl/cu124

log "Installing transformers + training dependencies via uv..."
uv pip install --quiet \
  transformers \
  datasets \
  accelerate \
  peft \
  bitsandbytes \
  sentencepiece \
  protobuf \
  safetensors

log "Installing APOLLO optimizer (required — no alternatives)..."
uv pip install --quiet apollo-torch

log "Installing FlashAttention2 for H200 (sm_90)..."
# FlashAttention2 must be compiled against the installed torch/CUDA.
# --no-build-isolation ensures it picks up the environment's torch headers.
pip install --quiet ninja
pip install --quiet flash-attn --no-build-isolation

log "Verifying APOLLO..."
python -c "import apollo_torch; print('APOLLO OK:', apollo_torch.__version__ if hasattr(apollo_torch, '__version__') else 'installed')"

log "Verifying flash-attn..."
python -c "import flash_attn; print('flash-attn OK:', flash_attn.__version__)"

log "Verifying torch + CUDA..."
python - <<'EOF'
import torch
assert torch.cuda.is_available(), "CUDA not available — check instance type"
name = torch.cuda.get_device_name(0)
mem  = torch.cuda.get_device_properties(0).total_memory // (1024**3)
print(f"GPU: {name} | VRAM: {mem} GB")
assert torch.cuda.is_bf16_supported(), "BF16 not supported on this device"
print("BF16: supported")
EOF

log "Container setup complete."
