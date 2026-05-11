#!/usr/bin/env bash
# cuda_runner.sh — drive CUDA fixture parity plus graph dispatch smoke.
#
# Usage on a Linux box that has nvcc + an NVIDIA GPU and a smoke GGUF model:
#   cd packages/inference/verify
#   ELIZA_DFLASH_SMOKE_MODEL=/models/eliza-1-smoke.gguf ./cuda_runner.sh
#
# Usage from a non-CUDA dev box (e.g. M4 Max) — drive a remote CUDA host
# over ssh:
#   CUDA_REMOTE=user@cuda-host CUDA_REMOTE_DIR=~/eliza ./cuda_runner.sh
#
# Environment overrides (optional):
#   CUDA_HOME                  default /usr/local/cuda
#   CUDA_TARGET                default linux-x64-cuda or linux-aarch64-cuda
#   CUDA_BUILD_FORK            default 1; build the target before verifying
#   CUDA_SKIP_GRAPH_SMOKE      default 0; set 1 only for fixture-only bring-up
#   ELIZA_DFLASH_LLAMA_DIR     default ~/.cache/eliza-dflash/milady-llama-cpp
#   ELIZA_DFLASH_LIBGGML_CUDA  default $ELIZA_DFLASH_LLAMA_DIR/build-cuda/ggml/src/ggml-cuda/libggml-cuda.so
#   ELIZA_DFLASH_SMOKE_MODEL   required unless CUDA_SKIP_GRAPH_SMOKE=1

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$HERE" rev-parse --show-toplevel)"
cd "$HERE"

host_arch_target() {
    case "$(uname -m)" in
        x86_64|amd64) printf 'linux-x64-cuda' ;;
        aarch64|arm64) printf 'linux-aarch64-cuda' ;;
        *) printf 'linux-unknown-cuda' ;;
    esac
}

if [[ -n "${CUDA_REMOTE:-}" ]]; then
    REMOTE_DIR="${CUDA_REMOTE_DIR:-~/eliza}/packages/inference/verify"
    echo "[cuda_runner] remote host: $CUDA_REMOTE"
    echo "[cuda_runner] remote dir:  $REMOTE_DIR"
    ssh "$CUDA_REMOTE" "cd $REMOTE_DIR && env \
        CUDA_HOME='${CUDA_HOME:-/usr/local/cuda}' \
        CUDA_TARGET='${CUDA_TARGET:-}' \
        CUDA_BUILD_FORK='${CUDA_BUILD_FORK:-1}' \
        CUDA_SKIP_GRAPH_SMOKE='${CUDA_SKIP_GRAPH_SMOKE:-0}' \
        ELIZA_DFLASH_LLAMA_DIR='${ELIZA_DFLASH_LLAMA_DIR:-~/.cache/eliza-dflash/milady-llama-cpp}' \
        ELIZA_DFLASH_LIBGGML_CUDA='${ELIZA_DFLASH_LIBGGML_CUDA:-}' \
        ELIZA_DFLASH_SMOKE_MODEL='${ELIZA_DFLASH_SMOKE_MODEL:-}' \
        ELIZA_DFLASH_SMOKE_CACHE_TYPES='${ELIZA_DFLASH_SMOKE_CACHE_TYPES:-}' \
        ./cuda_runner.sh"
    exit $?
fi

if [[ "$(uname -s)" != "Linux" ]]; then
    echo "[cuda_runner] CUDA hardware verification requires Linux + NVIDIA driver; this host is $(uname -s)."
    exit 1
fi

if ! command -v nvcc >/dev/null 2>&1; then
    echo "[cuda_runner] nvcc not on PATH — see CUDA_VERIFICATION.md"
    echo "[cuda_runner] install: apt install nvidia-cuda-toolkit  (Linux)"
    exit 1
fi

if ! command -v nvidia-smi >/dev/null 2>&1; then
    echo "[cuda_runner] nvidia-smi missing — refusing to count this as CUDA hardware verification"
    exit 1
fi

if ! nvidia-smi -L >/dev/null 2>&1; then
    echo "[cuda_runner] nvidia-smi did not report an NVIDIA GPU"
    exit 1
fi

CUDA_TARGET="${CUDA_TARGET:-$(host_arch_target)}"
if [[ "$CUDA_TARGET" == *unknown* ]]; then
    echo "[cuda_runner] unsupported host arch for CUDA target: $(uname -m)"
    exit 1
fi

echo "[cuda_runner] target=$CUDA_TARGET"
nvidia-smi --query-gpu=name,driver_version,compute_cap --format=csv,noheader || nvidia-smi -L
nvcc --version

if [[ "${CUDA_BUILD_FORK:-1}" != "0" ]]; then
    node "$REPO_ROOT/packages/app-core/scripts/build-llama-cpp-dflash.mjs" --target "$CUDA_TARGET"
fi

make cuda-verify

if [[ "${CUDA_SKIP_GRAPH_SMOKE:-0}" == "1" ]]; then
    echo "[cuda_runner] CUDA_SKIP_GRAPH_SMOKE=1 — fixture parity only; graph dispatch NOT verified."
    exit 0
fi

"$HERE/runtime_graph_smoke.sh" \
    --target "$CUDA_TARGET" \
    --backend-pattern 'CUDA|cuda|cuBLAS|ggml_cuda|NVIDIA'
