#!/usr/bin/env bash
set -euo pipefail

# Isaac Sim + IsaacLab environment bootstrap.
# Validates prerequisites, creates a venv, and installs bridge dependencies.
# Pin versions via bridge/config/isaaclab_versions.json.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ISAAC_ENV_DIR="${ISAAC_ENV_DIR:-$HOME/.venvs/ainex-isaac}"
ISAACLAB_DIR="${ISAACLAB_DIR:-$HOME/IsaacLab}"
VERSIONS_FILE="$ROOT_DIR/bridge/config/isaaclab_versions.json"

# ---- helpers ----
info()  { echo "[INFO]  $*"; }
warn()  { echo "[WARN]  $*"; }
fail()  { echo "[FAIL]  $*" >&2; exit 1; }

# ---- prerequisite checks ----
info "Checking prerequisites..."

# Python version
PYTHON_VERSION="$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
info "Python version: $PYTHON_VERSION"

# GPU driver
if command -v nvidia-smi >/dev/null 2>&1; then
  DRIVER_VERSION="$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1)"
  GPU_NAME="$(nvidia-smi --query-gpu=name --format=csv,noheader | head -1)"
  VRAM_MB="$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | head -1)"
  info "GPU: $GPU_NAME | Driver: $DRIVER_VERSION | VRAM: ${VRAM_MB}MB"

  VRAM_GB=$((VRAM_MB / 1024))
  if [ "$VRAM_GB" -lt 8 ]; then
    warn "VRAM ${VRAM_GB}GB is below recommended minimum of 8GB"
  fi
else
  warn "nvidia-smi not found. GPU driver may not be installed."
fi

# CUDA
if command -v nvcc >/dev/null 2>&1; then
  CUDA_VERSION="$(nvcc --version | grep -oP 'release \K[0-9.]+')"
  info "CUDA version: $CUDA_VERSION"
else
  warn "nvcc not found. CUDA toolkit may not be installed."
fi

# ---- create virtual environment ----
info "Creating virtual environment at: $ISAAC_ENV_DIR"
python3 -m venv "$ISAAC_ENV_DIR"
# shellcheck disable=SC1091
source "$ISAAC_ENV_DIR/bin/activate"
python -m pip install --upgrade pip wheel setuptools

# ---- install bridge dependencies ----
info "Installing bridge Python dependencies..."
pip install -r "$ROOT_DIR/bridge/requirements.txt"

# ---- IsaacLab clone guidance ----
if [ -d "$ISAACLAB_DIR" ]; then
  info "IsaacLab directory found at: $ISAACLAB_DIR"
else
  info "IsaacLab not found at $ISAACLAB_DIR"
  info "Clone with:"
  info "  git clone https://github.com/isaac-sim/IsaacLab.git $ISAACLAB_DIR"
  info "  cd $ISAACLAB_DIR && git checkout v2.1.0"
  info "Then follow upstream install instructions."
fi

# ---- summary ----
echo
info "Environment ready at: $ISAAC_ENV_DIR"
info "Activate with: source $ISAAC_ENV_DIR/bin/activate"
info ""
info "Next steps:"
info "  1. Install Isaac Sim (see https://docs.isaacsim.omniverse.nvidia.com/)"
info "  2. Install IsaacLab (cd $ISAACLAB_DIR && ./isaaclab.sh --install)"
info "  3. Export URDF: ./bridge/scripts/prepare_ainex_urdf.sh"
info "  4. Convert to USD: python bridge/isaaclab/convert_urdf_to_usd.py"
info "  5. Start bridge: ./bridge/scripts/start_rosbridge_isaac.sh"
