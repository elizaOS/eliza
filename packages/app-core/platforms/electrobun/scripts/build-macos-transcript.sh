#!/usr/bin/env bash
# Builds the native macOS transcript renderer (native/macos/transcript-view.mm)
# into src/libMacTranscriptView.dylib, mirroring build-macos-effects.sh so the
# two dylibs share one toolchain contract. Non-darwin hosts get an empty
# placeholder file (same convention) so packaging never trips on a missing path.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_FILE="$ROOT_DIR/native/macos/transcript-view.mm"
OUT_FILE="$ROOT_DIR/src/libMacTranscriptView.dylib"

if [[ "$(uname -s)" != "Darwin" ]]; then
	mkdir -p "$(dirname "$OUT_FILE")"
	: >"$OUT_FILE"
	echo "Created placeholder native macOS transcript dylib: $OUT_FILE"
	exit 0
fi

if [[ ! -f "$SRC_FILE" ]]; then
	echo "Missing source file: $SRC_FILE"
	exit 1
fi

mkdir -p "$(dirname "$OUT_FILE")"
xcrun clang++ \
  -dynamiclib \
  -std=c++17 \
  -fobjc-arc \
  -framework Cocoa \
  "$SRC_FILE" \
  -o "$OUT_FILE"
echo "Built native macOS transcript renderer: $OUT_FILE"
