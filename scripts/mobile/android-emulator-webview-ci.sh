#!/usr/bin/env bash
# Drives the Android WebView test lanes after the emulator is ready. The
# emulator action treats each nonblank input line as a separate `sh -c`
# process, so the workflow invokes this file in one line and Bash owns the
# host-agent process, readiness loop, traps, and test sequence end to end.

set -euo pipefail

MODE=${1:-}
case "$MODE" in
  full | pr-smoke) ;;
  *)
    echo "usage: $0 <full|pr-smoke>" >&2
    exit 64
    ;;
esac

REPO_ROOT=${GITHUB_WORKSPACE:?GITHUB_WORKSPACE must identify the checked-out repository}
cd "$REPO_ROOT"

adb root || true
adb shell setenforce 0 || true
bun run --cwd packages/app build

RESULTS_DIR=packages/app/test-results/android-onboarding-to-home
mkdir -p "$RESULTS_DIR"
ELIZA_API_PORT=31337 \
ELIZA_PAIRING_DISABLED=1 \
  node packages/app-core/scripts/run-node-tsx.mjs \
    packages/app-core/scripts/serve-real-local-agent.ts \
    >"$RESULTS_DIR/host-agent.log" 2>&1 &
HOST_AGENT_PID=$!

cleanup_host_agent() {
  local status=$?
  trap - EXIT
  # The host process must not outlive the emulator lane, even when a test fails.
  kill "$HOST_AGENT_PID" 2>/dev/null || true
  wait "$HOST_AGENT_PID" 2>/dev/null || true
  exit "$status"
}
trap cleanup_host_agent EXIT

case "$MODE" in
  full) CLIENT_ID=android-onboarding-ci ;;
  pr-smoke) CLIENT_ID=android-pr-device-smoke ;;
esac

HEALTH_RESPONSE=/tmp/android-host-agent-health.json
for _ in $(seq 1 90); do
  if curl -fsS \
    -H "X-ElizaOS-Client-Id: $CLIENT_ID" \
    http://127.0.0.1:31337/api/health >"$HEALTH_RESPONSE"; then
    cat "$HEALTH_RESPONSE"
    break
  fi
  if ! kill -0 "$HOST_AGENT_PID" 2>/dev/null; then
    echo "Host agent exited before becoming healthy" >&2
    cat "$RESULTS_DIR/host-agent.log" >&2
    exit 1
  fi
  sleep 2
done
curl -fsS \
  -H "X-ElizaOS-Client-Id: $CLIENT_ID" \
  http://127.0.0.1:31337/api/health >/dev/null

ELIZA_ANDROID_BACKEND=host \
ELIZA_ANDROID_REQUIRE_AGENT=1 \
  bun run --cwd packages/app test:e2e:android:onboarding

if [[ "$MODE" == "pr-smoke" ]]; then
  # These probes remain observational until an API-34 emulator run supplies
  # the evidence required by #13580 to make them PR gates.
  ELIZA_ANDROID_BACKEND=host \
  ELIZA_ANDROID_REQUIRE_AGENT=1 \
    bun run --cwd packages/app test:e2e:android:native-plugin-view || true
  ELIZA_ANDROID_BACKEND=host \
  ELIZA_ANDROID_REQUIRE_AGENT=1 \
  ELIZA_ANDROID_CLEAR_APP_DATA=1 \
    bun run --cwd packages/app test:e2e:android:touch-gesture || true
  ELIZA_ANDROID_BACKEND=host \
  ELIZA_ANDROID_REQUIRE_AGENT=1 \
    bun run --cwd packages/app test:e2e:android:view-runtime-soak || true
  exit 0
fi

if [[ ${ELIZA_ANDROID_BACKEND:?ELIZA_ANDROID_BACKEND must select a route backend} == "local" ]]; then
  # Embedded bun+llama requires the arm64 runner tracked by #13580; hosted x86
  # still records its failure without misclassifying the platform limitation.
  ELIZA_ANDROID_REQUIRE_AGENT=1 \
    bun run --cwd packages/app test:e2e:android:routes || true
else
  ELIZA_ANDROID_REQUIRE_AGENT=0 \
    bun run --cwd packages/app test:e2e:android:routes
fi

ELIZA_ANDROID_BACKEND=host \
ELIZA_ANDROID_REQUIRE_AGENT=1 \
  bun run --cwd packages/app test:e2e:android:native-plugin-view

# The hosted run collects the remaining x86 and gesture evidence while the
# arm64-local and launcher gates are being qualified for promotion.
bun run --cwd packages/app test:sim:local-chat:android:live || true
ELIZA_ANDROID_BACKEND=host \
ELIZA_ANDROID_REQUIRE_AGENT=1 \
  bun run --cwd packages/app test:e2e:android:launcher-loop || true
ELIZA_ANDROID_BACKEND=host \
ELIZA_ANDROID_REQUIRE_AGENT=1 \
ELIZA_ANDROID_CLEAR_APP_DATA=1 \
  bun run --cwd packages/app test:e2e:android:touch-gesture || true
ELIZA_ANDROID_BACKEND=host \
ELIZA_ANDROID_REQUIRE_AGENT=1 \
  bun run --cwd packages/app test:e2e:android:view-runtime-soak || true
