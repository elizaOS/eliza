#!/usr/bin/env bash
set -euo pipefail

NATIVE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../native/macos" && pwd)"
SRC_FILE="$NATIVE_DIR/native-permissions.mm"
OUT_FILE="$NATIVE_DIR/libMacWindowEffects.dylib"

if [[ "$(uname -s)" != "Darwin" ]]; then
	echo "The macOS native permissions bridge builds only on macOS."
	exit 1
fi

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
echo "Built the macOS native permissions bridge: $OUT_FILE"
