#!/usr/bin/env bash
# Runs one emulator lane in a single shell so traps, loops, and process state survive.

set -euo pipefail
adb root || true
adb shell setenforce 0 || true
bun run --cwd packages/app build  # ensure web dist

mkdir -p packages/app/test-results/android-onboarding-to-home
ELIZA_API_PORT=31337 \
ELIZA_PAIRING_DISABLED=1 \
  node packages/app-core/scripts/run-node-tsx.mjs \
    packages/app-core/scripts/serve-real-local-agent.ts \
    > packages/app/test-results/android-onboarding-to-home/host-agent.log 2>&1 &
HOST_AGENT_PID=$!
trap 'kill "$HOST_AGENT_PID" 2>/dev/null || true' EXIT
for i in $(seq 1 90); do
  if curl -fsS \
    -H 'X-ElizaOS-Client-Id: android-pr-device-smoke' \
    http://127.0.0.1:31337/api/health >/tmp/android-host-agent-health.json; then
    cat /tmp/android-host-agent-health.json
    break
  fi
  if ! kill -0 "$HOST_AGENT_PID" 2>/dev/null; then
    echo "Host agent exited before becoming healthy"
    cat packages/app/test-results/android-onboarding-to-home/host-agent.log
    exit 1
  fi
  sleep 2
done
curl -fsS \
  -H 'X-ElizaOS-Client-Id: android-pr-device-smoke' \
  http://127.0.0.1:31337/api/health >/dev/null

# Onboarding→home + first chat turn, asserted against the host agent.
ELIZA_ANDROID_BACKEND=host \
ELIZA_ANDROID_REQUIRE_AGENT=1 \
  bun run --cwd packages/app test:e2e:android:onboarding

# Native plugin x WebView smoke: proves Capacitor JS calls cross
# into Android Kotlin rather than the desktop Chromium bridge shim.
# Signal-only (|| true) on the PR lane until it's proven green on the
# x86_64 API-34 emulator this job uses — the hard assertion runs in
# the workflow_dispatch `android-e2e` job (validated on a real arm64
# device). Do not make it a hard PR gate on unproven-on-emulator
# evidence; flip to a hard gate once an emulator-green run is attached.
ELIZA_ANDROID_BACKEND=host \
ELIZA_ANDROID_REQUIRE_AGENT=1 \
  bun run --cwd packages/app test:e2e:android:native-plugin-view || true

# Real OS-level touch swipe on the chat-sheet grabber (#9943): proves
# the home→launcher pager gesture fires with real Android touch input
# (pointerMouseCount===0), not desktop mouse emulation. Signal-only on
# the PR lane for the same reason as above — flip to a hard gate once
# emulator-green evidence is attached.
ELIZA_ANDROID_BACKEND=host \
ELIZA_ANDROID_REQUIRE_AGENT=1 \
ELIZA_ANDROID_CLEAR_APP_DATA=1 \
  bun run --cwd packages/app test:e2e:android:touch-gesture || true

# View-runtime telemetry soak (#10196): activates every registered
# view through the real eliza:navigate:view channel and asserts
# bounded render/heap/cache behavior. Signal-only on the PR lane.
ELIZA_ANDROID_BACKEND=host \
ELIZA_ANDROID_REQUIRE_AGENT=1 \
  bun run --cwd packages/app test:e2e:android:view-runtime-soak || true
