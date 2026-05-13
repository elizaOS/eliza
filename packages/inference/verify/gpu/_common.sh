#!/usr/bin/env bash
# packages/inference/verify/gpu/_common.sh
#
# Shared bash helpers for the per-card verification scripts
# (verify_3090.sh / verify_4090.sh / verify_5090.sh / verify_h200.sh).
#
# Each per-card script:
#   1. Sources this file.
#   2. Sets PROFILE_ID, EXPECTED_SHORT_NAME, EXPECTED_CUDA_ARCH.
#   3. Calls `run_gpu_verify "$@"`.
#
# The shared logic:
#   - Validates nvidia-smi reports the expected GPU.
#   - Reads the per-card YAML (via `node -e` — no model load).
#   - Calls `make cuda-verify` in the parent dir (kernel-fixture parity).
#   - Optionally runs `llama-bench` against a smoke model (only when
#     ELIZA_GPU_BENCH=1 — defaults off, so the script is safe to run
#     on a Mac for `--help` / dry-run checks).
#   - Emits JSON evidence to evidence/gpu/<gpu>/<timestamp>.json.
#
# **DOES NOT LOAD ANY MODEL > 1.7B by default**. The bench step requires
# an explicit opt-in (`ELIZA_GPU_BENCH=1`) plus an `ELIZA_DFLASH_SMOKE_MODEL`
# path. The script aborts early when neither is set in `--bench` mode.
#
# Usage:
#   ./verify_4090.sh --help
#   ./verify_4090.sh --dry-run                # validates env, no work
#   ELIZA_GPU_BENCH=1 ELIZA_DFLASH_SMOKE_MODEL=/path/to/9b.gguf \
#       ./verify_4090.sh

set -euo pipefail

# Resolved by the caller after sourcing.
: "${PROFILE_ID:?PROFILE_ID must be set before sourcing _common.sh}"
: "${EXPECTED_SHORT_NAME:?EXPECTED_SHORT_NAME must be set}"
: "${EXPECTED_CUDA_ARCH:?EXPECTED_CUDA_ARCH must be set}"

GPU_VERIFY_USAGE() {
    cat <<USAGE
Usage:
  ${0##*/} [--help] [--dry-run]

Validates the host GPU matches the expected card (${EXPECTED_SHORT_NAME})
and that the buun-llama-cpp fork has the per-profile kernels available.

Reads per-bundle deployment recommendations from:
  packages/shared/src/local-inference-gpu/profiles/${PROFILE_ID}.yaml

Environment:
  ELIZA_GPU_BENCH=1                 enable the llama-bench TPS smoke
                                    (requires ELIZA_DFLASH_SMOKE_MODEL)
  ELIZA_DFLASH_SMOKE_MODEL=<path>   GGUF to bench (must be the smoke_bundle
                                    declared in the YAML, or a smaller tier)
  ELIZA_DFLASH_LLAMA_DIR=<path>     llama.cpp build root
                                    (default: ~/.cache/eliza-dflash/eliza-llama-cpp)
  ELIZA_GPU_REPORT_DIR=<path>       evidence output dir
                                    (default: evidence/gpu/${PROFILE_ID})

Exit codes:
  0  pass
  2  GPU mismatch (refused to run; will not silently downgrade)
  3  toolchain missing (no nvidia-smi / no nvcc)
  4  YAML profile parse failure
  5  bench failed or TPS outside tolerance
USAGE
}

case "${1:-}" in
    -h|--help)
        GPU_VERIFY_USAGE; exit 0 ;;
esac

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
    DRY_RUN=1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$HERE" rev-parse --show-toplevel 2>/dev/null || echo "$HERE/../../../../..")"
VERIFY_DIR="$(cd "$HERE/.." && pwd)"
YAML_PATH="$REPO_ROOT/packages/shared/src/local-inference-gpu/profiles/${PROFILE_ID}.yaml"

REPORT_DIR="${ELIZA_GPU_REPORT_DIR:-$VERIFY_DIR/evidence/gpu/$PROFILE_ID}"
TIMESTAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
REPORT_PATH="$REPORT_DIR/${TIMESTAMP}.json"

abort() {
    local code="$1"; shift
    echo "[verify-${PROFILE_ID}] $*" >&2
    exit "$code"
}

# ---- pre-flight ----------------------------------------------------------
[[ -f "$YAML_PATH" ]] || abort 4 "missing profile YAML: $YAML_PATH"

if (( DRY_RUN == 1 )); then
    echo "[verify-${PROFILE_ID}] --dry-run mode: validating YAML + reading expected kernels…"
fi

# Parse the YAML once. We resolve `yaml` from the shared package's
# node_modules so the script works regardless of caller cwd. If that
# fails the YAML may still be malformed — fatal in either case.
SHARED_PKG_DIR="$REPO_ROOT/packages/shared"
NODE_SCRIPT='import { readFileSync } from "node:fs";
import YAML from "yaml";
const yaml = YAML.parse(readFileSync(process.env.YAML_PATH, "utf8"));
const cmake = yaml.verify_recipe.cmake_flags.join("|");
const kernels = yaml.verify_recipe.expected_kernels.join(",");
process.stdout.write([
  yaml.gpu_id,
  yaml.verify_recipe.cuda_arch,
  cmake,
  kernels,
  yaml.verify_recipe.smoke_bundle,
  yaml.verify_recipe.tolerance_pct,
].join(" "));'
PARSED_LINE="$( (cd "$SHARED_PKG_DIR" && YAML_PATH="$YAML_PATH" node --input-type=module -e "$NODE_SCRIPT") 2>/dev/null || true )"
read -r PARSED_GPU_ID PARSED_ARCH PARSED_CMAKE_FLAGS PARSED_KERNELS PARSED_SMOKE_BUNDLE PARSED_TOLERANCE <<< "$PARSED_LINE"
[[ -n "${PARSED_GPU_ID:-}" ]] || abort 4 "failed to parse $YAML_PATH (yaml dep missing? run 'bun install' in packages/shared)"
[[ "$PARSED_GPU_ID" == "$PROFILE_ID" ]] || abort 4 "YAML gpu_id mismatch: $PARSED_GPU_ID vs $PROFILE_ID"
[[ "$PARSED_ARCH" == "$EXPECTED_CUDA_ARCH" ]] || abort 4 "YAML cuda_arch mismatch: $PARSED_ARCH vs $EXPECTED_CUDA_ARCH"
echo "[verify-${PROFILE_ID}] yaml ok: arch=$PARSED_ARCH smoke=$PARSED_SMOKE_BUNDLE tol=${PARSED_TOLERANCE}%"
echo "[verify-${PROFILE_ID}] expected kernels: $PARSED_KERNELS"

if (( DRY_RUN == 1 )); then
    echo "[verify-${PROFILE_ID}] dry-run complete; not running nvidia-smi / make cuda-verify"
    exit 0
fi

# ---- nvidia-smi GPU match -----------------------------------------------
command -v nvidia-smi >/dev/null 2>&1 || abort 3 "nvidia-smi missing — verification cannot proceed (try on a Linux host with an NVIDIA driver)"
GPU_QUERY="$(nvidia-smi --query-gpu=name,memory.total,compute_cap --format=csv,noheader 2>/dev/null || true)"
[[ -n "$GPU_QUERY" ]] || abort 3 "nvidia-smi returned no GPUs"
GPU_NAME="$(printf '%s\n' "$GPU_QUERY" | head -1 | awk -F', ' '{print $1}')"
GPU_MEMORY="$(printf '%s\n' "$GPU_QUERY" | head -1 | awk -F', ' '{print $2}')"
GPU_COMPUTE="$(printf '%s\n' "$GPU_QUERY" | head -1 | awk -F', ' '{print $3}')"

case "$EXPECTED_SHORT_NAME" in
    "3090") [[ "$GPU_NAME" == *"RTX 3090"* ]] || abort 2 "expected RTX 3090; nvidia-smi reports: $GPU_NAME" ;;
    "4090") [[ "$GPU_NAME" == *"RTX 4090"* ]] || abort 2 "expected RTX 4090; nvidia-smi reports: $GPU_NAME" ;;
    "5090") [[ "$GPU_NAME" == *"RTX 5090"* ]] || abort 2 "expected RTX 5090; nvidia-smi reports: $GPU_NAME" ;;
    "H200") [[ "$GPU_NAME" == *"H200"* ]]      || abort 2 "expected H200; nvidia-smi reports: $GPU_NAME" ;;
    *)      abort 2 "unknown EXPECTED_SHORT_NAME=$EXPECTED_SHORT_NAME" ;;
esac
echo "[verify-${PROFILE_ID}] gpu match ok: $GPU_NAME ($GPU_MEMORY, compute_cap=$GPU_COMPUTE)"

# ---- kernel-fixture parity (cheap, no model load) ----------------------
command -v nvcc >/dev/null 2>&1 || abort 3 "nvcc missing — install CUDA toolkit ${EXPECTED_CUDA_ARCH}-class"
echo "[verify-${PROFILE_ID}] running 'make cuda-verify'…"
(cd "$VERIFY_DIR" && make cuda-verify)

# ---- optional bench (gated; expensive) ---------------------------------
BENCH_STATUS="skipped"
BENCH_DECODE_TPS=""
BENCH_PREFILL_TPS=""
if [[ "${ELIZA_GPU_BENCH:-0}" == "1" ]]; then
    SMOKE_MODEL="${ELIZA_DFLASH_SMOKE_MODEL:-}"
    [[ -n "$SMOKE_MODEL" && -f "$SMOKE_MODEL" ]] || abort 5 "ELIZA_GPU_BENCH=1 set but ELIZA_DFLASH_SMOKE_MODEL is missing/not a file"
    LLAMA_DIR="${ELIZA_DFLASH_LLAMA_DIR:-$HOME/.cache/eliza-dflash/eliza-llama-cpp}"
    LLAMA_BENCH="$LLAMA_DIR/build-cuda/bin/llama-bench"
    [[ -x "$LLAMA_BENCH" ]] || abort 5 "llama-bench missing at $LLAMA_BENCH (build with: bun run packages/app-core/scripts/build-llama-cpp-dflash.mjs --target linux-x64-cuda)"
    echo "[verify-${PROFILE_ID}] llama-bench: $SMOKE_MODEL"
    BENCH_OUT="$("$LLAMA_BENCH" -m "$SMOKE_MODEL" -ngl 999 -fa 1 -p 512 -n 128 2>&1 || true)"
    echo "$BENCH_OUT"
    # llama-bench output ends with markdown tables; extract pp512 / tg128 columns.
    BENCH_PREFILL_TPS="$(printf '%s\n' "$BENCH_OUT" | awk '/pp512/ {gsub(/[\t ]+/, " "); print $NF}' | head -1)"
    BENCH_DECODE_TPS="$(printf '%s\n' "$BENCH_OUT" | awk '/tg128/ {gsub(/[\t ]+/, " "); print $NF}' | head -1)"
    if [[ -n "$BENCH_DECODE_TPS" && -n "$BENCH_PREFILL_TPS" ]]; then
        BENCH_STATUS="completed"
    else
        BENCH_STATUS="parse-failed"
    fi
else
    echo "[verify-${PROFILE_ID}] bench skipped (set ELIZA_GPU_BENCH=1 + ELIZA_DFLASH_SMOKE_MODEL to run)"
fi

# ---- evidence JSON ------------------------------------------------------
mkdir -p "$REPORT_DIR"
GPU_NAME_J="$GPU_NAME" \
GPU_MEMORY_J="$GPU_MEMORY" \
GPU_COMPUTE_J="$GPU_COMPUTE" \
PROFILE_ID_J="$PROFILE_ID" \
PARSED_TOLERANCE_J="$PARSED_TOLERANCE" \
PARSED_SMOKE_BUNDLE_J="$PARSED_SMOKE_BUNDLE" \
BENCH_STATUS_J="$BENCH_STATUS" \
BENCH_DECODE_TPS_J="$BENCH_DECODE_TPS" \
BENCH_PREFILL_TPS_J="$BENCH_PREFILL_TPS" \
REPORT_PATH_J="$REPORT_PATH" \
node --input-type=module <<'NODE'
import { writeFileSync } from "node:fs";
const r = {
  schemaVersion: 1,
  runner: `verify_${process.env.PROFILE_ID_J}.sh`,
  startedAt: new Date().toISOString(),
  profileId: process.env.PROFILE_ID_J,
  smokeBundle: process.env.PARSED_SMOKE_BUNDLE_J,
  tolerancePct: Number(process.env.PARSED_TOLERANCE_J),
  gpu: {
    name: process.env.GPU_NAME_J,
    memory: process.env.GPU_MEMORY_J,
    computeCap: process.env.GPU_COMPUTE_J,
  },
  bench: {
    status: process.env.BENCH_STATUS_J,
    decodeTps: process.env.BENCH_DECODE_TPS_J || null,
    prefillTps: process.env.BENCH_PREFILL_TPS_J || null,
  },
};
writeFileSync(process.env.REPORT_PATH_J, `${JSON.stringify(r, null, 2)}\n`);
console.log(`[verify-${process.env.PROFILE_ID_J}] evidence: ${process.env.REPORT_PATH_J}`);
NODE

echo "[verify-${PROFILE_ID}] PASS"
