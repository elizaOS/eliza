#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_FILE="$ROOT_DIR/native/macos/window-effects.mm"
OUT_FILE="$ROOT_DIR/src/libMacWindowEffects.dylib"

if [[ "$(uname -s)" != "Darwin" ]]; then
	mkdir -p "$(dirname "$OUT_FILE")"
	: >"$OUT_FILE"
	echo "Created placeholder native macOS effects dylib: $OUT_FILE"
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
  -framework ApplicationServices \
  -framework AVFoundation \
  -framework Contacts \
  -framework CoreGraphics \
  -framework CoreLocation \
  -framework EventKit \
  -framework UserNotifications \
  "$SRC_FILE" \
  -o "$OUT_FILE"
echo "Built native macOS effects: $OUT_FILE"
