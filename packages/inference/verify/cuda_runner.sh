#!/usr/bin/env bash
# cuda_runner.sh — drive cuda_verify against all five fixtures on a CUDA host.
#
# Usage on a Linux box that has nvcc + an NVIDIA GPU:
#   cd packages/inference/verify
#   ./cuda_runner.sh
#
# Usage from a non-CUDA dev box (e.g. M4 Max) — drive a remote CUDA host
# over ssh:
#   CUDA_REMOTE=user@cuda-host CUDA_REMOTE_DIR=~/eliza ./cuda_runner.sh
#
# Environment overrides (optional):
#   CUDA_HOME                  default /usr/local/cuda
#   ELIZA_DFLASH_LLAMA_DIR     default ~/.cache/eliza-dflash/milady-llama-cpp
#   ELIZA_DFLASH_LIBGGML_CUDA  default $ELIZA_DFLASH_LLAMA_DIR/build-cuda/ggml/src/ggml-cuda/libggml-cuda.so

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

if [[ -n "${CUDA_REMOTE:-}" ]]; then
    REMOTE_DIR="${CUDA_REMOTE_DIR:-~/eliza}/packages/inference/verify"
    echo "[cuda_runner] remote host: $CUDA_REMOTE"
    echo "[cuda_runner] remote dir:  $REMOTE_DIR"
    ssh "$CUDA_REMOTE" "cd $REMOTE_DIR && \
        CUDA_HOME=${CUDA_HOME:-/usr/local/cuda} \
        ELIZA_DFLASH_LLAMA_DIR=${ELIZA_DFLASH_LLAMA_DIR:-~/.cache/eliza-dflash/milady-llama-cpp} \
        ELIZA_DFLASH_LIBGGML_CUDA=${ELIZA_DFLASH_LIBGGML_CUDA:-} \
        make cuda-verify"
    exit $?
fi

if ! command -v nvcc >/dev/null 2>&1; then
    echo "[cuda_runner] nvcc not on PATH — see CUDA_VERIFICATION.md"
    echo "[cuda_runner] install: apt install nvidia-cuda-toolkit  (Linux)"
    exit 1
fi

if ! command -v nvidia-smi >/dev/null 2>&1; then
    echo "[cuda_runner] WARNING: nvidia-smi missing — driver may not be installed"
fi

make cuda-verify
