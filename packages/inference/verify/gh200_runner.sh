#!/usr/bin/env bash
# gh200_runner.sh — strict Linux aarch64 + Hopper CUDA verification entrypoint.
#
# Accepts GH200/H200/H100-class hosts. The required shape is arm64 Linux host
# userspace plus an NVIDIA GPU with compute capability 9.x. It delegates to
# cuda_runner.sh after pinning the aarch64 CUDA target and sm_90a build arch.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPORT_PATH="${ELIZA_DFLASH_HARDWARE_REPORT:-}"
STARTED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
FAIL_REASON=""
GPU_INFO=""

usage() {
    cat <<'USAGE' >&2
Usage:
  gh200_runner.sh [--report <path>]

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
            usage; echo "[gh200_runner] unknown argument: $1" >&2; exit 1 ;;
    esac
done

fail() {
    FAIL_REASON="$*"
    echo "[gh200_runner] $FAIL_REASON" >&2
    exit 1
}

on_error() {
    local line="$1"
    local command="$2"
    if [[ -z "$FAIL_REASON" ]]; then
        FAIL_REASON="command failed at line $line: $command"
    fi
}

write_report() {
    local exit_code="$1"
    [[ -n "$REPORT_PATH" ]] || return 0
    mkdir -p "$(dirname "$REPORT_PATH")"
    RUNNER="gh200_runner.sh" \
    STATUS="$([[ "$exit_code" == "0" ]] && printf pass || printf fail)" \
    PASS_RECORDABLE="$([[ "$exit_code" == "0" ]] && printf true || printf false)" \
    EXIT_CODE="$exit_code" \
    FAIL_REASON="$FAIL_REASON" \
    STARTED_AT="$STARTED_AT" \
    FINISHED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
    HOST_OS="$(uname -s 2>/dev/null || true)" \
    HOST_ARCH="$(uname -m 2>/dev/null || true)" \
    TARGET="${CUDA_TARGET:-linux-aarch64-cuda}" \
    GPU_INFO="$GPU_INFO" \
    CMAKE_FLAGS="${ELIZA_DFLASH_CMAKE_FLAGS:-}" \
    MODEL="${ELIZA_DFLASH_SMOKE_MODEL:-}" \
    REPORT_PATH="$REPORT_PATH" \
    node <<'NODE' || true
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
  target: env.TARGET,
  requirements: {
    os: 'Linux',
    arch: 'aarch64/arm64',
    hardware: 'H100/H200/GH200-class NVIDIA GPU or compute capability 9.x',
    delegatedRunner: 'cuda_runner.sh'
  },
  evidence: {
    gpuInfo: env.GPU_INFO || null,
    cmakeFlags: env.CMAKE_FLAGS || null,
    model: env.MODEL || null
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

if [[ "$(uname -s)" != "Linux" ]]; then
    fail "GH200 verification requires Linux; this host is $(uname -s)."
fi

case "$(uname -m)" in
    aarch64|arm64) ;;
    *)
        fail "GH200-like verification requires aarch64/arm64 Linux host userspace; host arch is $(uname -m)."
        ;;
esac

if ! command -v nvidia-smi >/dev/null 2>&1; then
    fail "nvidia-smi missing — NVIDIA driver/GPU required."
fi

GPU_INFO="$(nvidia-smi --query-gpu=name,compute_cap --format=csv,noheader 2>/dev/null || true)"
if [[ -z "$GPU_INFO" ]]; then
    fail "nvidia-smi did not return GPU name/compute capability."
fi
echo "$GPU_INFO"

if ! grep -Eq '(H100|H200|GH200|Grace Hopper|9\.[0-9])' <<<"$GPU_INFO"; then
    fail "expected Hopper/GH200-class GPU (name H100/H200/GH200 or compute capability 9.x)."
fi

export CUDA_TARGET="${CUDA_TARGET:-linux-aarch64-cuda}"
if [[ -z "${ELIZA_DFLASH_CMAKE_FLAGS:-}" ]]; then
    export ELIZA_DFLASH_CMAKE_FLAGS='-DCMAKE_CUDA_ARCHITECTURES=90a'
fi

"$HERE/cuda_runner.sh"
