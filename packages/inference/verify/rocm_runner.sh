#!/usr/bin/env bash
# rocm_runner.sh — build the ROCm/HIP target and run model-backed graph smoke.
#
# This runner intentionally fails without a real AMD GPU and a GGUF smoke
# model. There is not yet a standalone HIP fixture harness equivalent to
# cuda_verify; this script verifies the built fork routes the configured KV
# cache types through a HIP-backed llama-cli invocation.
#
# Environment overrides:
#   ROCM_TARGET                 default linux-x64-rocm
#   ROCM_BUILD_FORK             default 1; build the target before verifying
#   ROCM_SKIP_GRAPH_SMOKE       default 0; set 1 only for preflight bring-up
#   ELIZA_DFLASH_CMAKE_FLAGS    default gfx90a/gfx942/RDNA3 HIP arch list
#   ELIZA_DFLASH_HARDWARE_REPORT_DIR
#                               graph-smoke log directory, default verify/hardware-results
#   ELIZA_DFLASH_SMOKE_MODEL    required unless ROCM_SKIP_GRAPH_SMOKE=1
#   ELIZA_DFLASH_SMOKE_CACHE_TYPES/TOKENS/NGL/PROMPT/EXTRA_ARGS
#                               forwarded to runtime_graph_smoke.sh

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$HERE" rev-parse --show-toplevel)"
TARGET="${ROCM_TARGET:-linux-x64-rocm}"
REPORT_PATH="${ELIZA_DFLASH_HARDWARE_REPORT:-}"
STARTED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
FAIL_REASON=""
GPU_INFO=""
TOOLCHAIN_INFO=""
GRAPH_SMOKE_STATUS="required"

usage() {
    cat <<'USAGE' >&2
Usage:
  rocm_runner.sh [--report <path>]

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
            usage; echo "[rocm_runner] unknown argument: $1" >&2; exit 1 ;;
    esac
done

fail() {
    FAIL_REASON="$*"
    echo "[rocm_runner] $FAIL_REASON" >&2
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
    [[ -n "$REPORT_PATH" ]] || return 0
    mkdir -p "$(dirname "$REPORT_PATH")"
    RUNNER="rocm_runner.sh" \
    STATUS="$([[ "$exit_code" == "0" ]] && printf pass || printf fail)" \
    PASS_RECORDABLE="$([[ "$exit_code" == "0" && "$GRAPH_SMOKE_STATUS" == "required" ]] && printf true || printf false)" \
    EXIT_CODE="$exit_code" \
    FAIL_REASON="$FAIL_REASON" \
    STARTED_AT="$STARTED_AT" \
    FINISHED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
    HOST_OS="$(uname -s 2>/dev/null || true)" \
    HOST_ARCH="$(uname -m 2>/dev/null || true)" \
    TARGET="$TARGET" \
    GPU_INFO="$GPU_INFO" \
    TOOLCHAIN_INFO="$TOOLCHAIN_INFO" \
    CMAKE_FLAGS="${ELIZA_DFLASH_CMAKE_FLAGS:-}" \
    MODEL="${ELIZA_DFLASH_SMOKE_MODEL:-}" \
    MODEL_SHA256="$(model_sha256)" \
    GRAPH_SMOKE_STATUS="$GRAPH_SMOKE_STATUS" \
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
  target: env.TARGET,
  requirements: {
    os: 'Linux',
    arch: 'x86_64/amd64',
    toolchain: ['hipcc', 'rocminfo'],
    hardware: 'gfx* AMD GPU agent reported by rocminfo',
    graphSmoke: env.GRAPH_SMOKE_STATUS,
    fixtureParity: 'blocked until HIP fixture harness exists'
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

if [[ "$(uname -s)" != "Linux" ]]; then
    fail "ROCm verification requires Linux; this host is $(uname -s)."
fi

case "$(uname -m)" in
    x86_64|amd64) ;;
    *)
        fail "$TARGET currently expects x86_64 Linux; host arch is $(uname -m)."
        ;;
esac

for cmd in hipcc rocminfo; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        fail "$cmd not on PATH — install ROCm/HIP before verifying."
    fi
done

ROCINFO_LOG="${ELIZA_DFLASH_HARDWARE_REPORT_DIR:-$HERE/hardware-results}/rocm-rocminfo.log"
mkdir -p "$(dirname "$ROCINFO_LOG")"
if ! rocminfo >"$ROCINFO_LOG" 2>&1; then
    fail "rocminfo failed; see $ROCINFO_LOG"
fi
if ! grep -Eiq 'Name:[[:space:]]+gfx[0-9a-f]+' "$ROCINFO_LOG"; then
    fail "rocminfo did not report a gfx AMD GPU agent; refusing to count this as hardware verification; see $ROCINFO_LOG"
fi

TOOLCHAIN_INFO="$(hipcc --version)"
GPU_INFO="$(grep -Ei 'Name:[[:space:]]+gfx|Marketing Name' "$ROCINFO_LOG" | head -20 || true)"
printf '%s\n' "$TOOLCHAIN_INFO"
printf '%s\n' "$GPU_INFO"

if [[ -z "${ELIZA_DFLASH_CMAKE_FLAGS:-}" ]]; then
    # MI250/MI300 + RDNA3 defaults; operators can override for a narrower lab.
    export ELIZA_DFLASH_CMAKE_FLAGS='-DCMAKE_HIP_ARCHITECTURES=gfx90a;gfx942;gfx1100;gfx1101;gfx1102'
fi

if [[ "${ROCM_BUILD_FORK:-1}" != "0" ]]; then
    node "$REPO_ROOT/packages/app-core/scripts/build-llama-cpp-dflash.mjs" --target "$TARGET"
fi

if [[ "${ROCM_SKIP_GRAPH_SMOKE:-0}" == "1" ]]; then
    GRAPH_SMOKE_STATUS="skipped"
    fail "ROCM_SKIP_GRAPH_SMOKE=1 — build/hardware preflight only; graph dispatch NOT verified, so no hardware pass can be recorded"
fi

"$HERE/runtime_graph_smoke.sh" \
    --target "$TARGET" \
    --backend-pattern 'HIP|ROCm|rocBLAS|ggml_hip|AMD'
