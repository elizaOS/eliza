#!/usr/bin/env bash
# Vendor a stock upstream llama.cpp checkout for the GGUF Q4_K_M path.
#
# The quantization wrappers (scripts/quantization/gguf-q4_k_m_apply.py and
# friends) shell out to llama.cpp's two stage GGUF conversion:
#
#   1. convert_hf_to_gguf.py  — HF safetensors → single file f16 GGUF
#   2. llama-quantize         — f16 GGUF → Q4_K_M (4 bit K quant)
#
# This script clones https://github.com/ggml-org/llama.cpp into
# packages/training/vendor/llama.cpp (pinned to a tag), builds the
# llama-quantize binary (CPU only build is sufficient), and installs the
# Python deps convert_hf_to_gguf.py needs (the `gguf` package + transformers
# friends from requirements.txt). It is idempotent: an existing checkout is
# reused, an existing build is reused, and pip install is a no-op when the
# deps are already present.
#
# NOTE: this is STOCK upstream llama.cpp. The custom GGML types used by the
# Milady inference fork (Q4_POLAR=47, QJL1_256=46, TurboQuant TBQ4_0/TBQ3_0)
# live in elizaOS/llama.cpp, NOT here — gguf_milady_apply.py / the optimize
# pipeline still want LLAMA_CPP_DIR pointed at that fork. See README.md.
#
# Override knobs (env vars):
#   LLAMA_CPP_VENDOR_DIR   — where to clone (default packages/training/vendor/llama.cpp)
#   LLAMA_CPP_GIT_URL      — clone URL (default https://github.com/ggml-org/llama.cpp)
#   LLAMA_CPP_TAG          — git tag/ref to pin (default below)
#   LLAMA_CPP_BUILD_JOBS   — parallel build jobs (default: nproc)
#   LLAMA_CPP_SKIP_PYDEPS  — set to 1 to skip the pip install step
set -euo pipefail

# --- config ---------------------------------------------------------------
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRAINING_ROOT="$(cd "$HERE/.." && pwd)"

VENDOR_DIR="${LLAMA_CPP_VENDOR_DIR:-$TRAINING_ROOT/vendor/llama.cpp}"
GIT_URL="${LLAMA_CPP_GIT_URL:-https://github.com/ggml-org/llama.cpp}"
# Pin a recent upstream release tag. llama.cpp tags master with monotonic
# build numbers (bNNNN). Bump this when you need a newer convert script or
# quant kernel; the checkout is reused across runs once cloned.
LLAMA_CPP_TAG="${LLAMA_CPP_TAG:-b6650}"
BUILD_JOBS="${LLAMA_CPP_BUILD_JOBS:-$(nproc 2>/dev/null || echo 4)}"

log() { printf '[vendor_llama_cpp] %s\n' "$*"; }
die() { printf '[vendor_llama_cpp] ERROR: %s\n' "$*" >&2; exit 1; }

command -v git >/dev/null 2>&1 || die "git not found on PATH"
command -v cmake >/dev/null 2>&1 || die "cmake not found on PATH (apt install cmake)"

# --- clone (idempotent) ---------------------------------------------------
if [[ -d "$VENDOR_DIR/.git" ]]; then
  log "checkout already present at $VENDOR_DIR — reusing"
  if [[ -n "${LLAMA_CPP_TAG:-}" ]]; then
    # Best-effort: fetch + checkout the pinned tag if it isn't what's there.
    current="$(git -C "$VENDOR_DIR" describe --tags --always 2>/dev/null || echo '?')"
    if [[ "$current" != "$LLAMA_CPP_TAG" ]]; then
      log "current ref '$current' != pinned '$LLAMA_CPP_TAG' — fetching"
      git -C "$VENDOR_DIR" fetch --depth 1 origin "tag" "$LLAMA_CPP_TAG" 2>/dev/null \
        || git -C "$VENDOR_DIR" fetch origin 2>/dev/null || true
      git -C "$VENDOR_DIR" checkout -q "$LLAMA_CPP_TAG" 2>/dev/null \
        || log "could not checkout $LLAMA_CPP_TAG; keeping $current"
    fi
  fi
else
  mkdir -p "$(dirname "$VENDOR_DIR")"
  log "cloning $GIT_URL @ $LLAMA_CPP_TAG -> $VENDOR_DIR"
  if ! git clone --depth 1 --branch "$LLAMA_CPP_TAG" "$GIT_URL" "$VENDOR_DIR" 2>/dev/null; then
    log "tag $LLAMA_CPP_TAG not directly cloneable; falling back to full clone + checkout"
    git clone "$GIT_URL" "$VENDOR_DIR"
    git -C "$VENDOR_DIR" checkout -q "$LLAMA_CPP_TAG" \
      || die "tag/ref '$LLAMA_CPP_TAG' not found in $GIT_URL"
  fi
fi

# --- build llama-quantize (idempotent) ------------------------------------
BUILD_DIR="$VENDOR_DIR/build"
QUANT_BIN="$BUILD_DIR/bin/llama-quantize"
if [[ -x "$QUANT_BIN" ]]; then
  log "llama-quantize already built: $QUANT_BIN"
else
  log "configuring cmake build (CPU only) in $BUILD_DIR"
  # GGML_NATIVE=OFF keeps the binary portable across the build host's exact
  # microarch; we don't need SIMD specialization for a one shot quantize.
  cmake -S "$VENDOR_DIR" -B "$BUILD_DIR" \
    -DCMAKE_BUILD_TYPE=Release \
    -DLLAMA_CURL=OFF \
    -DGGML_NATIVE=OFF \
    -DBUILD_SHARED_LIBS=OFF
  log "building target llama-quantize (-j$BUILD_JOBS)"
  cmake --build "$BUILD_DIR" --target llama-quantize -j"$BUILD_JOBS"
  [[ -x "$QUANT_BIN" ]] || die "build finished but $QUANT_BIN is missing"
fi

# --- python deps for convert_hf_to_gguf.py --------------------------------
CONVERT_SCRIPT="$VENDOR_DIR/convert_hf_to_gguf.py"
[[ -f "$CONVERT_SCRIPT" ]] || die "convert_hf_to_gguf.py not found in $VENDOR_DIR"

if [[ "${LLAMA_CPP_SKIP_PYDEPS:-0}" == "1" ]]; then
  log "LLAMA_CPP_SKIP_PYDEPS=1 — skipping pip install for convert script"
else
  # Prefer `uv pip` when available (the training package uses uv); fall back
  # to plain pip. requirements.txt pulls numpy/transformers/sentencepiece/etc.
  PIP_CMD=()
  if command -v uv >/dev/null 2>&1; then
    PIP_CMD=(uv pip install)
  elif command -v pip >/dev/null 2>&1; then
    PIP_CMD=(pip install)
  elif command -v python3 >/dev/null 2>&1; then
    PIP_CMD=(python3 -m pip install)
  fi
  if [[ ${#PIP_CMD[@]} -eq 0 ]]; then
    log "WARNING: no pip/uv found — install the 'gguf' package yourself for convert_hf_to_gguf.py"
  else
    REQ_FILE="$VENDOR_DIR/requirements.txt"
    if [[ -f "$REQ_FILE" ]]; then
      log "installing convert deps: ${PIP_CMD[*]} -r $REQ_FILE"
      "${PIP_CMD[@]}" -r "$REQ_FILE" || log "WARNING: requirements.txt install failed; convert script may not import"
    else
      log "no requirements.txt; installing 'gguf' package directly"
      "${PIP_CMD[@]}" gguf || log "WARNING: 'gguf' install failed"
    fi
  fi
fi

# --- report ---------------------------------------------------------------
log "done."
log "  checkout:        $VENDOR_DIR"
log "  ref:             $(git -C "$VENDOR_DIR" describe --tags --always 2>/dev/null || echo '?')"
log "  convert script:  $CONVERT_SCRIPT"
log "  llama-quantize:  $QUANT_BIN"
log ""
log "The gguf-q4_k_m_apply.py wrapper auto-discovers these (no env var needed)."
log "To point a script at a different checkout: export LLAMA_CPP_DIR=$VENDOR_DIR"
