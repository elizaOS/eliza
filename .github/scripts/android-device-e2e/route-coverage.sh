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
    -H 'X-ElizaOS-Client-Id: android-onboarding-ci' \
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
  -H 'X-ElizaOS-Client-Id: android-onboarding-ci' \
  http://127.0.0.1:31337/api/health >/dev/null

ELIZA_ANDROID_BACKEND=host \
ELIZA_ANDROID_REQUIRE_AGENT=1 \
  bun run --cwd packages/app test:e2e:android:onboarding

if [ "${ELIZA_ANDROID_BACKEND}" = "local" ]; then
  # LOCAL route is still signal-only on hosted x86_64: the embedded
  # bun+llama agent is known to require a self-hosted arm64 device
  # runner. Keep surfacing the artifact, but do not make the hosted
  # emulator falsely red for that known platform gap.
  ELIZA_ANDROID_REQUIRE_AGENT=1 \
    bun run --cwd packages/app test:e2e:android:routes || true
else
  # Host/cloud route coverage is the scheduled unattended health
  # signal. Fail red here instead of hiding regressions behind a
  # permanent signal-only `|| true` leg.
  ELIZA_ANDROID_REQUIRE_AGENT=0 \
    bun run --cwd packages/app test:e2e:android:routes
fi
ELIZA_ANDROID_BACKEND=host \
ELIZA_ANDROID_REQUIRE_AGENT=1 \
  bun run --cwd packages/app test:e2e:android:native-plugin-view
# Local on-device agent smoke (surfaces failure loudly; expected to
# fail on stock x86 emulator — see coverage note above).
bun run --cwd packages/app test:sim:local-chat:android:live || true

# Seeded launcher gesture loop (#12377): ≥200 real device swipes/taps
# with per-action rail invariants (data-page + AX probe + inertness +
# focus), chunked screenrecord + logcat. Signal-only on the x86
# emulator until proven emulator-green; the seed prints for replay.
ELIZA_ANDROID_BACKEND=host \
ELIZA_ANDROID_REQUIRE_AGENT=1 \
  bun run --cwd packages/app test:e2e:android:launcher-loop || true
