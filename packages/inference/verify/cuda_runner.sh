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
#   CUDA_REMOTE_REPORT         remote report path when driving CUDA_REMOTE
#   ELIZA_DFLASH_CMAKE_FLAGS   extra target CMake flags passed to the build hook
#   ELIZA_DFLASH_HARDWARE_REPORT_DIR
#                              graph-smoke log directory, default verify/hardware-results
#   ELIZA_DFLASH_LLAMA_DIR     default ~/.cache/eliza-dflash/eliza-llama-cpp
#   ELIZA_DFLASH_LIBGGML_CUDA  default $ELIZA_DFLASH_LLAMA_DIR/build-cuda/ggml/src/ggml-cuda/libggml-cuda.so
#   ELIZA_DFLASH_SMOKE_MODEL   required unless CUDA_SKIP_GRAPH_SMOKE=1
#   ELIZA_DFLASH_SMOKE_CACHE_TYPES/TOKENS/NGL/PROMPT/EXTRA_ARGS
#                              forwarded to runtime_graph_smoke.sh

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$HERE" rev-parse --show-toplevel)"
cd "$HERE"

REPORT_PATH="${ELIZA_DFLASH_HARDWARE_REPORT:-}"
STARTED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
FAIL_REASON=""
GPU_INFO=""
TOOLCHAIN_INFO=""
GRAPH_SMOKE_STATUS="required"
REMOTE_DELEGATED="false"
REPORT_WRITTEN_EXTERNALLY="false"

usage() {
    cat <<'USAGE' >&2
Usage:
  cuda_runner.sh [--report <path>]

Options:
  --report <path>   Write machine-readable JSON evidence for pass/fail.
USAGE
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --report)
            REPORT_PATH="${2:-}"; shift 2 ;;
        -h|--help)
            usage; exit 0 ;;
        *)
            usage; echo "[cuda_runner] unknown argument: $1" >&2; exit 1 ;;
    esac
done

fail() {
    FAIL_REASON="$*"
    echo "[cuda_runner] $FAIL_REASON" >&2
    exit 1
}

on_error() {
    local line="$1"
    local command="$2"
    if [[ -z "$FAIL_REASON" ]]; then
        FAIL_REASON="command failed at line $line: $command"
    fi
}

model_sha256() {
    local model="${ELIZA_DFLASH_SMOKE_MODEL:-}"
    [[ -n "$model" && -f "$model" ]] || return 0
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$model" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$model" | awk '{print $1}'
    fi
}

write_report() {
    local exit_code="$1"
    [[ "$REPORT_WRITTEN_EXTERNALLY" != "true" ]] || return 0
    [[ -n "$REPORT_PATH" ]] || return 0
    mkdir -p "$(dirname "$REPORT_PATH")"
    RUNNER="cuda_runner.sh" \
    STATUS="$([[ "$exit_code" == "0" ]] && printf pass || printf fail)" \
    PASS_RECORDABLE="$([[ "$exit_code" == "0" && "$GRAPH_SMOKE_STATUS" == "required" ]] && printf true || printf false)" \
    EXIT_CODE="$exit_code" \
    FAIL_REASON="$FAIL_REASON" \
    STARTED_AT="$STARTED_AT" \
    FINISHED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
    HOST_OS="$(uname -s 2>/dev/null || true)" \
    HOST_ARCH="$(uname -m 2>/dev/null || true)" \
    TARGET="${CUDA_TARGET:-}" \
    GPU_INFO="$GPU_INFO" \
    TOOLCHAIN_INFO="$TOOLCHAIN_INFO" \
    CMAKE_FLAGS="${ELIZA_DFLASH_CMAKE_FLAGS:-}" \
    MODEL="${ELIZA_DFLASH_SMOKE_MODEL:-}" \
    MODEL_SHA256="$(model_sha256)" \
    GRAPH_SMOKE_STATUS="$GRAPH_SMOKE_STATUS" \
    REMOTE_DELEGATED="$REMOTE_DELEGATED" \
    REPORT_PATH="$REPORT_PATH" \
    node <<'NODE'
const fs = require('node:fs');
const env = process.env;
const report = {
  schemaVersion: 1,
  runner: env.RUNNER,
  status: env.STATUS,
  passRecordable: env.PASS_RECORDABLE === 'true',
  exitCode: Number(env.EXIT_CODE || 0),
  failureReason: env.FAIL_REASON || null,
  startedAt: env.STARTED_AT,
  finishedAt: env.FINISHED_AT,
  host: { os: env.HOST_OS, arch: env.HOST_ARCH },
  target: env.TARGET || null,
  remoteDelegated: env.REMOTE_DELEGATED === 'true',
  requirements: {
    os: 'Linux',
    toolchain: ['nvcc', 'nvidia-smi'],
    hardware: 'NVIDIA GPU reported by nvidia-smi',
    fixtures: 'make cuda-verify all six fixtures',
    graphSmoke: env.GRAPH_SMOKE_STATUS
  },
  evidence: {
    gpuInfo: env.GPU_INFO || null,
    toolchainInfo: env.TOOLCHAIN_INFO || null,
    cmakeFlags: env.CMAKE_FLAGS || null,
    model: env.MODEL || null,
    modelSha256: env.MODEL_SHA256 || null
  }
};
fs.writeFileSync(env.REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
NODE
}

finish() {
    local exit_code=$?
    write_report "$exit_code"
}
trap finish EXIT
trap 'on_error "$LINENO" "$BASH_COMMAND"' ERR

host_arch_target() {
    case "$(uname -m)" in
        x86_64|amd64) printf 'linux-x64-cuda' ;;
        aarch64|arm64) printf 'linux-aarch64-cuda' ;;
        *) printf 'linux-unknown-cuda' ;;
    esac
}

if [[ -n "${CUDA_REMOTE:-}" ]]; then
    REMOTE_DELEGATED="true"
    REMOTE_DIR="${CUDA_REMOTE_DIR:-~/eliza}/packages/inference/verify"
    REMOTE_LLAMA_DIR="${ELIZA_DFLASH_LLAMA_DIR:-\$HOME/.cache/eliza-dflash/eliza-llama-cpp}"
    REMOTE_REPORT_PATH="${CUDA_REMOTE_REPORT:-}"
    if [[ -n "$REPORT_PATH" && -z "$REMOTE_REPORT_PATH" ]]; then
        REMOTE_REPORT_PATH="hardware-results/$(basename "$REPORT_PATH")"
    fi
    REMOTE_REPORT_ARG=""
    if [[ -n "$REMOTE_REPORT_PATH" ]]; then
        REMOTE_REPORT_ARG="--report '$REMOTE_REPORT_PATH'"
    fi
    echo "[cuda_runner] remote host: $CUDA_REMOTE"
    echo "[cuda_runner] remote dir:  $REMOTE_DIR"
    if ! ssh "$CUDA_REMOTE" "cd $REMOTE_DIR && env \
        CUDA_HOME='${CUDA_HOME:-/usr/local/cuda}' \
        CUDA_TARGET='${CUDA_TARGET:-}' \
        CUDA_BUILD_FORK='${CUDA_BUILD_FORK:-1}' \
        CUDA_SKIP_GRAPH_SMOKE='${CUDA_SKIP_GRAPH_SMOKE:-0}' \
        ELIZA_DFLASH_CMAKE_FLAGS='${ELIZA_DFLASH_CMAKE_FLAGS:-}' \
        ELIZA_DFLASH_HARDWARE_REPORT_DIR='${ELIZA_DFLASH_HARDWARE_REPORT_DIR:-}' \
        ELIZA_DFLASH_LLAMA_DIR=$REMOTE_LLAMA_DIR \
        ELIZA_DFLASH_LIBGGML_CUDA='${ELIZA_DFLASH_LIBGGML_CUDA:-}' \
        ELIZA_DFLASH_SMOKE_MODEL='${ELIZA_DFLASH_SMOKE_MODEL:-}' \
        ELIZA_DFLASH_SMOKE_CACHE_TYPES='${ELIZA_DFLASH_SMOKE_CACHE_TYPES:-}' \
        ELIZA_DFLASH_SMOKE_TOKENS='${ELIZA_DFLASH_SMOKE_TOKENS:-}' \
        ELIZA_DFLASH_SMOKE_NGL='${ELIZA_DFLASH_SMOKE_NGL:-}' \
        ELIZA_DFLASH_SMOKE_PROMPT='${ELIZA_DFLASH_SMOKE_PROMPT:-}' \
        ELIZA_DFLASH_SMOKE_EXTRA_ARGS='${ELIZA_DFLASH_SMOKE_EXTRA_ARGS:-}' \
        ./cuda_runner.sh $REMOTE_REPORT_ARG"; then
        fail "remote CUDA verification failed on $CUDA_REMOTE"
    fi
    if [[ -n "$REPORT_PATH" ]]; then
        REMOTE_REPORT_SOURCE="$REMOTE_REPORT_PATH"
        case "$REMOTE_REPORT_SOURCE" in
            /*|~*) ;;
            *) REMOTE_REPORT_SOURCE="$REMOTE_DIR/$REMOTE_REPORT_SOURCE" ;;
        esac
        mkdir -p "$(dirname "$REPORT_PATH")"
        if ! scp "$CUDA_REMOTE:$REMOTE_REPORT_SOURCE" "$REPORT_PATH"; then
            fail "remote CUDA verification passed but report fetch failed: $CUDA_REMOTE:$REMOTE_REPORT_SOURCE"
        fi
        REPORT_WRITTEN_EXTERNALLY="true"
    fi
    exit 0
fi

if [[ "$(uname -s)" != "Linux" ]]; then
    fail "CUDA hardware verification requires Linux + NVIDIA driver; this host is $(uname -s)."
fi

if ! command -v nvcc >/dev/null 2>&1; then
    fail "nvcc not on PATH — see CUDA_VERIFICATION.md; install CUDA Toolkit on Linux"
fi

if ! command -v nvidia-smi >/dev/null 2>&1; then
    fail "nvidia-smi missing — refusing to count this as CUDA hardware verification"
fi

if ! nvidia-smi -L >/dev/null 2>&1; then
    fail "nvidia-smi did not report an NVIDIA GPU"
fi

CUDA_TARGET="${CUDA_TARGET:-$(host_arch_target)}"
if [[ "$CUDA_TARGET" == *unknown* ]]; then
    fail "unsupported host arch for CUDA target: $(uname -m)"
fi

echo "[cuda_runner] target=$CUDA_TARGET"
GPU_INFO="$(nvidia-smi --query-gpu=name,driver_version,compute_cap --format=csv,noheader 2>/dev/null || nvidia-smi -L)"
TOOLCHAIN_INFO="$(nvcc --version)"
printf '%s\n' "$GPU_INFO"
printf '%s\n' "$TOOLCHAIN_INFO"

if [[ "${CUDA_BUILD_FORK:-1}" != "0" ]]; then
    node "$REPO_ROOT/packages/app-core/scripts/build-llama-cpp-dflash.mjs" --target "$CUDA_TARGET"
fi

make cuda-verify

if [[ "${CUDA_SKIP_GRAPH_SMOKE:-0}" == "1" ]]; then
    GRAPH_SMOKE_STATUS="skipped"
    fail "CUDA_SKIP_GRAPH_SMOKE=1 — fixture parity only; graph dispatch NOT verified, so no hardware pass can be recorded"
fi

"$HERE/runtime_graph_smoke.sh" \
    --target "$CUDA_TARGET" \
    --backend-pattern 'CUDA|cuda|cuBLAS|ggml_cuda|NVIDIA' \
    --gen-check
