#!/system/bin/sh
# launch.sh — device-side launcher for the on-device Eliza agent.
#
# Staged into the APK by run-mobile-build.mjs and copied to the app's
# private data dir by ElizaAgentService on first launch. Daemonises bun
# via a setsid double-fork so the agent survives the service that kicked
# it off; without that adb shell / Service.onCreate parents reap it.
#
# Required env vars:
#   DEVICE_DIR  Absolute path on the device that holds bun + musl + bundle.
#   LD_NAME     Per-ABI musl loader filename (ld-musl-{x86_64,aarch64}.so.1).
#   PORT        Loopback port for Bun.serve() to bind 127.0.0.1 on.
#
# Optional:
#   AGENT_BUNDLE  Defaults to "agent-bundle.js" in DEVICE_DIR.
#   LOG_FILE      Defaults to "agent.log" in DEVICE_DIR.

DEVICE_DIR=${DEVICE_DIR:-/data/local/tmp}
LD_NAME=${LD_NAME:-ld-musl-x86_64.so.1}
PORT=${PORT:-31337}
AGENT_BUNDLE=${AGENT_BUNDLE:-agent-bundle.js}
LOG_FILE=${LOG_FILE:-${DEVICE_DIR}/agent.log}

cd "$DEVICE_DIR" || exit 1
pkill -f "${DEVICE_DIR}/bun" 2>/dev/null
sleep 1

(
  setsid sh -c "exec </dev/null >\"$LOG_FILE\" 2>&1; LD_LIBRARY_PATH=\"$DEVICE_DIR\" PORT=\"$PORT\" exec \"$DEVICE_DIR/$LD_NAME\" \"$DEVICE_DIR/bun\" \"$DEVICE_DIR/$AGENT_BUNDLE\"" &
) &
disown 2>/dev/null || true
exit 0
