#!/usr/bin/env bash
# Rebuild the chat-UI harness for the iOS Simulator, install it on the booted
# sim (booting one if needed), launch it, and drop a screenshot. One command:
#
#   bun run ios:chat-harness:preview            # full rebuild + install + launch
#   bun run ios:chat-harness:preview -- --skip-build   # reinstall/launch last build
#
# The web bundle is baked into the .app at build time, so any renderer change
# requires the rebuild path (see AGENTS.md capture rules).
set -euo pipefail
cd "$(dirname "$0")/.."

# When this eliza checkout is nested inside an outer monorepo (milady),
# run-mobile-build's repo-root walk escapes to the outer root and builds the
# outer apps/app instead of THIS package. Pin the root to this checkout.
export ELIZA_MOBILE_REPO_ROOT="$(cd ../.. && pwd)"

BUNDLE_ID="${ELIZA_IOS_APP_ID:-ai.elizaos.app}"
DERIVED="${ELIZA_IOS_DERIVED_DATA_PATH:-$HOME/Library/Developer/Xcode/DerivedData/eliza-chat-harness}"
SKIP_BUILD=0
for arg in "$@"; do [[ "$arg" == "--skip-build" ]] && SKIP_BUILD=1; done

if [[ "$SKIP_BUILD" == 0 ]]; then
  ELIZA_IOS_DERIVED_DATA_PATH="$DERIVED" bun run build:ios:chat-harness
fi

APP_PATH="$DERIVED/Build/Products/Debug-iphonesimulator/App.app"
if [[ ! -d "$APP_PATH" ]]; then
  # Fall back to the newest App.app in default DerivedData (pre-script builds).
  APP_PATH=$(ls -dt "$HOME"/Library/Developer/Xcode/DerivedData/App-*/Build/Products/Debug-iphonesimulator/App.app 2>/dev/null | head -1 || true)
fi
[[ -d "${APP_PATH:-}" ]] || { echo "No built App.app found — run without --skip-build"; exit 1; }

UDID=$(xcrun simctl list devices booted --json | python3 -c 'import json,sys; d=json.load(sys.stdin)["devices"]; print(next((x["udid"] for r in d.values() for x in r if x["state"]=="Booted"), ""))')
if [[ -z "$UDID" ]]; then
  UDID=$(xcrun simctl list devices available --json | python3 -c 'import json,sys; d=json.load(sys.stdin)["devices"]; print(next((x["udid"] for r in d.values() for x in r if "iPhone 17 Pro"==x["name"]), ""))')
  xcrun simctl boot "$UDID"
  xcrun simctl bootstatus "$UDID" -b
fi
open -a Simulator

xcrun simctl install "$UDID" "$APP_PATH"
xcrun simctl terminate "$UDID" "$BUNDLE_ID" 2>/dev/null || true
xcrun simctl launch "$UDID" "$BUNDLE_ID"
sleep 4
SHOT="/tmp/chat-harness-$(date +%H%M%S).png"
xcrun simctl io "$UDID" screenshot "$SHOT"
echo "Installed $APP_PATH"
echo "Screenshot: $SHOT"
