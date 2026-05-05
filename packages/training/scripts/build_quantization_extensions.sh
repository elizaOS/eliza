#!/usr/bin/env bash
# Build the CUDA + Triton extensions the eliza-1 quantization stack needs.
#
# This script is the single source of truth for "set up a fresh GPU box
# so that QJL, fused-TurboQuant, and friends can actually run." It is
# called by training/Dockerfile during image build, and is also the
# command operators run on a bare-metal Vast / Lambda / on-prem GPU.
#
# What it does
# ------------
#   1. Builds the vendored QJL CUDA kernels in scripts/quantization/qjl/
#      via `python setup.py build_ext --inplace`. Requires nvcc and
#      python<ver>-dev headers on the system.
#
#   2. Verifies fused_turboquant_vendored can be imported. Triton is
#      JIT-only — there is no AOT step we can run at install time, so
#      this is the closest we can get to "Triton compiler is wired up
#      correctly". The actual kernel JIT happens on first call inside
#      a CUDA context.
#
# What it does not do
# -------------------
#   - It does not install system packages. The Dockerfile is responsible
#     for apt-get installing nvcc + python-dev. On bare metal, the user
#     installs those manually (see scripts/quantization/qjl/build.sh).
#   - It does not build vllm or any inference-side kernel. `serve_vllm.py`
#     consumes prebuilt vllm wheels from the `serve` extra.
#
# Exit codes
# ----------
#   0  — QJL built successfully, fused_turboquant_vendored imported.
#   1  — QJL build failed (typically nvcc missing or wrong arch list).
#   2  — fused_turboquant_vendored import failed (Triton or torch issue).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRAINING_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
QJL_DIR="${SCRIPT_DIR}/quantization/qjl"

PYTHON_BIN="${PYTHON:-python}"
if ! command -v "${PYTHON_BIN}" >/dev/null 2>&1; then
    PYTHON_BIN="python3"
fi

echo "[build_quantization_extensions] python: $(${PYTHON_BIN} --version)"
echo "[build_quantization_extensions] training dir: ${TRAINING_DIR}"
echo "[build_quantization_extensions] qjl dir:      ${QJL_DIR}"

if [[ ! -d "${QJL_DIR}" ]]; then
    echo "[build_quantization_extensions] FATAL: QJL source directory missing at ${QJL_DIR}" >&2
    exit 1
fi

# --- 1. QJL ---------------------------------------------------------------
# Defer to the in-tree build.sh which already auto-detects compute_cap
# from nvidia-smi and wires up TORCH_CUDA_ARCH_LIST. Inside Docker the
# Dockerfile pre-sets TORCH_CUDA_ARCH_LIST and the auto-detect is a
# no-op; on bare metal we get the local GPU's arch.
echo "[build_quantization_extensions] building QJL CUDA extensions..."
pushd "${QJL_DIR}" >/dev/null
PYTHON="${PYTHON_BIN}" bash ./build.sh
popd >/dev/null

# Sanity: at least one .so should now exist next to setup.py.
if ! ls "${QJL_DIR}"/*.so >/dev/null 2>&1; then
    echo "[build_quantization_extensions] FATAL: QJL build reported success but produced no .so files" >&2
    exit 1
fi
echo "[build_quantization_extensions] QJL .so artifacts:"
ls -1 "${QJL_DIR}"/*.so

# --- 2. fused-turboquant Triton import ------------------------------------
# The vendored package's __init__.py imports from
# `quantization.fused_turboquant_vendored.*`, which means the parent
# `quantization` directory must be on PYTHONPATH. scripts/ does that.
echo "[build_quantization_extensions] verifying fused_turboquant_vendored imports..."
PYTHONPATH="${SCRIPT_DIR}${PYTHONPATH:+:${PYTHONPATH}}" \
    "${PYTHON_BIN}" -c "import quantization.fused_turboquant_vendored as f; print('fused-turboquant', f.__version__)" \
    || { echo "[build_quantization_extensions] FATAL: fused_turboquant_vendored import failed" >&2; exit 2; }

echo "[build_quantization_extensions] OK — QJL built, fused-turboquant import verified"
