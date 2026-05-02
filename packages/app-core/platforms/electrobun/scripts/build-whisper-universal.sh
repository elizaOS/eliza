#!/usr/bin/env bash
#
# build-whisper-universal.sh
#
# Builds whisper.cpp's `main` binary as a macOS universal binary (arm64 + x86_64).
# This ensures whisper-based features (swabble wake-word, talkmode) work on both
# Apple Silicon and Intel Macs.
#
# Usage: bash apps/app/electrobun/scripts/build-whisper-universal.sh [model]
#
# model: tiny.en | base.en (default) | small.en | medium.en | large-v3
#
set -euo pipefail

MODEL="${1:-base.en}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

resolve_whisper_dir() {
  local candidates=()

  if [ -n "${ELIZA_WHISPER_CPP_DIR:-}" ]; then
    candidates+=("$ELIZA_WHISPER_CPP_DIR")
  fi

  candidates+=(
    "$PWD/node_modules/whisper-node/lib/whisper.cpp"
    "$(cd "$SCRIPT_DIR/../../../../../.." && pwd)/node_modules/whisper-node/lib/whisper.cpp"
    "$(cd "$SCRIPT_DIR/../../../../.." && pwd)/node_modules/whisper-node/lib/whisper.cpp"
    "$(cd "$SCRIPT_DIR/../../../.." && pwd)/node_modules/whisper-node/lib/whisper.cpp"
  )

  for candidate in "${candidates[@]}"; do
    if [ -d "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  printf '%s\n' "${candidates[0]}"
  return 1
}

WHISPER_CPP_DIR="$(resolve_whisper_dir || true)"
WHISPER_MODEL_DIR="$WHISPER_CPP_DIR/models"
WHISPER_MODEL_FILENAME="ggml-${MODEL}.bin"
WHISPER_MODEL_PATH="$WHISPER_MODEL_DIR/$WHISPER_MODEL_FILENAME"
WHISPER_MODEL_CACHE_DIR="${ELIZA_WHISPER_MODEL_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/eliza/whisper}"
WHISPER_MODEL_CACHE_PATH="$WHISPER_MODEL_CACHE_DIR/$WHISPER_MODEL_FILENAME"

patch_whisper_makefile() {
  local makefile_path="$WHISPER_CPP_DIR/Makefile"

  if [ ! -f "$makefile_path" ]; then
    return
  fi

  MAKEFILE_PATH="$makefile_path" node <<'NODE'
const fs = require("node:fs");

const makefilePath = process.env.MAKEFILE_PATH;
if (!makefilePath) {
  process.exit(0);
}

const original = fs.readFileSync(makefilePath, "utf8");
const patched = original
  .replace(
    "SYSCTL_M := $(shell sysctl -n hw.optional.arm64)",
    "SYSCTL_M := $(shell sysctl -n hw.optional.arm64 2>/dev/null || echo 0)",
  )
  .replace(
    "CFLAGS  += -DGGML_USE_ACCELERATE",
    "CFLAGS  += -DGGML_USE_ACCELERATE -Wno-deprecated-declarations",
  );

if (patched !== original) {
  fs.writeFileSync(makefilePath, patched, "utf8");
}
NODE
}

if [ ! -d "$WHISPER_CPP_DIR" ]; then
  echo "[whisper-universal] whisper.cpp directory not found at $WHISPER_CPP_DIR"
  echo "[whisper-universal] Checked \$PWD and the Eliza/eliza workspace node_modules paths."
  echo "[whisper-universal] Run 'bun install' first."
  exit 1
fi

cd "$WHISPER_CPP_DIR"
NCPU=$(sysctl -n hw.ncpu 2>/dev/null || echo 4)
patch_whisper_makefile

echo "[whisper-universal] Building whisper.cpp universal binary (arm64 + x86_64)..."
echo "[whisper-universal] Directory: $WHISPER_CPP_DIR"
echo ""

# --- arm64 build (native on Apple Silicon, or cross-compile on Intel) ---
echo "[whisper-universal] === Building arm64 ==="
make clean 2>/dev/null || true
make main -j"$NCPU" 2>&1
cp main main_arm64
echo "[whisper-universal] arm64 build OK: $(file main_arm64)"
echo ""

# --- x86_64 build (via Rosetta on Apple Silicon, or native on Intel) ---
# Disable Metal for x86_64 since older Intel Macs may lack GPU support.
echo "[whisper-universal] === Building x86_64 ==="
make clean 2>/dev/null || true
arch -x86_64 make main -j"$NCPU" WHISPER_NO_METAL=1 2>&1
cp main main_x86_64
echo "[whisper-universal] x86_64 build OK: $(file main_x86_64)"
echo ""

# --- Combine into universal (fat) binary ---
echo "[whisper-universal] === Creating universal binary with lipo ==="
lipo -create main_arm64 main_x86_64 -output main
rm -f main_arm64 main_x86_64

echo "[whisper-universal] Result: $(file main)"
lipo -detailed_info main
echo ""

# --- Ensure model is available ---
bash "$SCRIPT_DIR/ensure-whisper-model.sh" "$MODEL"

# --- Verify both slices execute ---
echo "[whisper-universal] === Verifying arm64 execution ==="
./main -h >/dev/null 2>&1 && echo "[whisper-universal] arm64 OK" || echo "[whisper-universal] arm64 FAILED"

echo "[whisper-universal] === Verifying x86_64 execution ==="
arch -x86_64 ./main -h >/dev/null 2>&1 && echo "[whisper-universal] x86_64 OK" || echo "[whisper-universal] x86_64 FAILED"

echo ""
echo "[whisper-universal] Done."
echo "    Binary: $WHISPER_CPP_DIR/main"
echo "    Model:  $WHISPER_MODEL_PATH"
echo "    Cache:  $WHISPER_MODEL_CACHE_PATH"
