#!/usr/bin/env bash
# Build whisper.cpp binary and download the base.en model.
# Run once after `bun install`, and again after upgrading whisper-node.
#
# Usage:
#   bash apps/app/electrobun/scripts/build-whisper.sh [model]
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

WHISPER_DIR="$(resolve_whisper_dir || true)"
WHISPER_MODEL_DIR="$WHISPER_DIR/models"
WHISPER_MODEL_FILENAME="ggml-${MODEL}.bin"
WHISPER_MODEL_PATH="$WHISPER_MODEL_DIR/$WHISPER_MODEL_FILENAME"
WHISPER_MODEL_CACHE_DIR="${ELIZA_WHISPER_MODEL_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/eliza/whisper}"
WHISPER_MODEL_CACHE_PATH="$WHISPER_MODEL_CACHE_DIR/$WHISPER_MODEL_FILENAME"

patch_whisper_makefile() {
  local makefile_path="$WHISPER_DIR/Makefile"

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

if [ ! -d "$WHISPER_DIR" ]; then
  echo "Error: whisper.cpp not found at $WHISPER_DIR" >&2
  echo "Checked \$PWD and the Eliza/eliza workspace node_modules paths." >&2
  echo "Run 'bun install' first." >&2
  exit 1
fi

echo "==> Building whisper.cpp in $WHISPER_DIR"
cd "$WHISPER_DIR"
patch_whisper_makefile
make main -j"$(nproc 2>/dev/null || sysctl -n hw.logicalcpu 2>/dev/null || echo 4)"

bash "$SCRIPT_DIR/ensure-whisper-model.sh" "$MODEL"

echo "==> Done. Binary: $WHISPER_DIR/main"
echo "    Model:  $WHISPER_MODEL_PATH"
echo "    Cache:  $WHISPER_MODEL_CACHE_PATH"
