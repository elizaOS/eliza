#!/usr/bin/env bash
# gh200_runner.sh — strict Linux aarch64 + Hopper CUDA verification entrypoint.
#
# Accepts GH200/H200/H100-class hosts. The required shape is arm64 Linux host
# userspace plus an NVIDIA GPU with compute capability 9.x. It delegates to
# cuda_runner.sh after pinning the aarch64 CUDA target and sm_90a build arch.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "$(uname -s)" != "Linux" ]]; then
    echo "[gh200_runner] GH200 verification requires Linux; this host is $(uname -s)." >&2
    exit 1
fi

case "$(uname -m)" in
    aarch64|arm64) ;;
    *)
        echo "[gh200_runner] GH200-like verification requires aarch64/arm64 Linux host userspace; host arch is $(uname -m)." >&2
        exit 1
        ;;
esac

if ! command -v nvidia-smi >/dev/null 2>&1; then
    echo "[gh200_runner] nvidia-smi missing — NVIDIA driver/GPU required." >&2
    exit 1
fi

GPU_INFO="$(nvidia-smi --query-gpu=name,compute_cap --format=csv,noheader 2>/dev/null || true)"
if [[ -z "$GPU_INFO" ]]; then
    echo "[gh200_runner] nvidia-smi did not return GPU name/compute capability." >&2
    exit 1
fi
echo "$GPU_INFO"

if ! grep -Eq '(H100|H200|GH200|Grace Hopper|9\.[0-9])' <<<"$GPU_INFO"; then
    echo "[gh200_runner] expected Hopper/GH200-class GPU (name H100/H200/GH200 or compute capability 9.x)." >&2
    exit 1
fi

export CUDA_TARGET="${CUDA_TARGET:-linux-aarch64-cuda}"
if [[ -z "${ELIZA_DFLASH_CMAKE_FLAGS:-}" ]]; then
    export ELIZA_DFLASH_CMAKE_FLAGS='-DCMAKE_CUDA_ARCHITECTURES=90a'
fi

exec "$HERE/cuda_runner.sh"
