#!/usr/bin/env bash
# rocm_runner.sh — build the ROCm/HIP target and run model-backed graph smoke.
#
# This runner intentionally fails without a real AMD GPU and a GGUF smoke
# model. There is not yet a standalone HIP fixture harness equivalent to
# cuda_verify; this script verifies the built fork routes the configured KV
# cache types through a HIP-backed llama-cli invocation.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$HERE" rev-parse --show-toplevel)"
TARGET="${ROCM_TARGET:-linux-x64-rocm}"

if [[ "$(uname -s)" != "Linux" ]]; then
    echo "[rocm_runner] ROCm verification requires Linux; this host is $(uname -s)." >&2
    exit 1
fi

case "$(uname -m)" in
    x86_64|amd64) ;;
    *)
        echo "[rocm_runner] $TARGET currently expects x86_64 Linux; host arch is $(uname -m)." >&2
        exit 1
        ;;
esac

for cmd in hipcc rocminfo; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "[rocm_runner] $cmd not on PATH — install ROCm/HIP before verifying." >&2
        exit 1
    fi
done

ROCINFO_LOG="${ELIZA_DFLASH_HARDWARE_REPORT_DIR:-$HERE/hardware-results}/rocm-rocminfo.log"
mkdir -p "$(dirname "$ROCINFO_LOG")"
if ! rocminfo >"$ROCINFO_LOG" 2>&1; then
    echo "[rocm_runner] rocminfo failed; see $ROCINFO_LOG" >&2
    exit 1
fi
if ! grep -Eiq 'Name:[[:space:]]+gfx[0-9a-f]+' "$ROCINFO_LOG"; then
    echo "[rocm_runner] rocminfo did not report a gfx AMD GPU agent; refusing to count this as hardware verification." >&2
    echo "[rocm_runner] see $ROCINFO_LOG" >&2
    exit 1
fi

hipcc --version
grep -Ei 'Name:[[:space:]]+gfx|Marketing Name' "$ROCINFO_LOG" | head -20 || true

if [[ -z "${ELIZA_DFLASH_CMAKE_FLAGS:-}" ]]; then
    # MI250/MI300 + RDNA3 defaults; operators can override for a narrower lab.
    export ELIZA_DFLASH_CMAKE_FLAGS='-DCMAKE_HIP_ARCHITECTURES=gfx90a;gfx942;gfx1100;gfx1101;gfx1102'
fi

if [[ "${ROCM_BUILD_FORK:-1}" != "0" ]]; then
    node "$REPO_ROOT/packages/app-core/scripts/build-llama-cpp-dflash.mjs" --target "$TARGET"
fi

if [[ "${ROCM_SKIP_GRAPH_SMOKE:-0}" == "1" ]]; then
    echo "[rocm_runner] ROCM_SKIP_GRAPH_SMOKE=1 — build/hardware preflight only; graph dispatch NOT verified."
    exit 0
fi

"$HERE/runtime_graph_smoke.sh" \
    --target "$TARGET" \
    --backend-pattern 'HIP|ROCm|rocBLAS|ggml_hip|AMD'
