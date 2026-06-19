#!/usr/bin/env bash
# Build the QJL CUDA extensions for the local GPU's compute capability.
#
# Detects the install's compute_cap via nvidia-smi and picks a sensible
# TORCH_CUDA_ARCH_LIST. Override by exporting TORCH_CUDA_ARCH_LIST before
# invoking this script.
#
# Examples
# --------
# Default auto-detect:
#     ./build.sh
#
# Force Blackwell consumer (RTX 5080/5090, RTX Pro Blackwell):
#     TORCH_CUDA_ARCH_LIST="12.0+PTX" ./build.sh
#
# Force Hopper datacenter (H100/H200):
#     TORCH_CUDA_ARCH_LIST="9.0" ./build.sh
#
# Force Ampere datacenter (A100):
#     TORCH_CUDA_ARCH_LIST="8.0" ./build.sh

set -euo pipefail

cd "$(dirname "$0")"

# Pick the Python interpreter. Honor the active venv first, then fall back
# to the system-default `python3`.
PYTHON="${PYTHON:-python3}"

if [[ -z "${TORCH_CUDA_ARCH_LIST:-}" ]]; then
  if command -v nvidia-smi >/dev/null 2>&1; then
    # nvidia-smi prints e.g. "compute_cap\n8.9\n9.0" — take the highest
    # cap on the box (multi-GPU rigs can mix arches).
    caps=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null \
           | tr -d ' ' | sort -V | uniq | paste -sd';' -)
    if [[ -z "${caps}" ]]; then
      echo "[build.sh] nvidia-smi found but returned no compute_cap; defaulting to 8.0;9.0"
      caps="8.0;9.0"
    fi
    # If any GPU is sm_120 (Blackwell consumer), keep PTX so PyTorch's
    # CUDA runtime can JIT-compile from PTX on systems that lack a SASS
    # compiler for sm_120 (e.g. CUDA 12.x toolchains).
    if [[ "${caps}" == *"12.0"* ]]; then
      caps="${caps//12.0/12.0+PTX}"
    fi
    export TORCH_CUDA_ARCH_LIST="${caps}"
    echo "[build.sh] auto-detected TORCH_CUDA_ARCH_LIST=${TORCH_CUDA_ARCH_LIST}"
  else
    export TORCH_CUDA_ARCH_LIST="8.0;9.0"
    echo "[build.sh] no nvidia-smi; defaulting TORCH_CUDA_ARCH_LIST=${TORCH_CUDA_ARCH_LIST}"
  fi
else
  echo "[build.sh] using preset TORCH_CUDA_ARCH_LIST=${TORCH_CUDA_ARCH_LIST}"
fi

if ! command -v nvcc >/dev/null 2>&1; then
  echo "[build.sh] ERROR: nvcc not found on PATH. Install CUDA toolkit:"
  echo "           sudo apt install nvidia-cuda-toolkit"
  echo "           # or download from https://developer.nvidia.com/cuda-downloads"
  exit 1
fi

PY_VER=$("${PYTHON}" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
PY_INCLUDE=$("${PYTHON}" -c 'import sysconfig; print(sysconfig.get_path("include"))')
if [[ ! -f "${PY_INCLUDE}/Python.h" ]]; then
  echo "[build.sh] ERROR: Python.h missing at ${PY_INCLUDE}. Install dev headers:"
  echo "           sudo apt install python${PY_VER}-dev"
  exit 1
fi

exec "${PYTHON}" setup.py build_ext --inplace "$@"
