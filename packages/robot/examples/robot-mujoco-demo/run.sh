#!/usr/bin/env bash
# Eliza ↔ MuJoCo AiNex demo launcher.
#
# Starts the MuJoCo bridge in the background, waits for it to listen, then
# launches `bun run dev` from the repo root with MILADY_AINEX_BRIDGE_URL
# set so plugin-ainex auto-enables.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROBOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
REPO_ROOT="$(cd "${ROBOT_DIR}/../.." && pwd)"

BRIDGE_PORT="${MILADY_AINEX_BRIDGE_PORT:-9100}"
TARGET_X="${MILADY_AINEX_TARGET_X:-2.0}"
TARGET_Y="${MILADY_AINEX_TARGET_Y:-0.0}"
TARGET_Z="${MILADY_AINEX_TARGET_Z:-0.05}"

cd "${ROBOT_DIR}"

echo "[robot-mujoco-demo] starting MuJoCo bridge on port ${BRIDGE_PORT}..."
uv run python -m eliza_robot.bridge.server \
  --backend mujoco \
  --port "${BRIDGE_PORT}" \
  --mujoco-target-x "${TARGET_X}" \
  --mujoco-target-y "${TARGET_Y}" \
  --mujoco-target-z "${TARGET_Z}" &
BRIDGE_PID=$!
trap 'echo "[robot-mujoco-demo] stopping bridge (pid=${BRIDGE_PID})"; kill ${BRIDGE_PID} 2>/dev/null || true' EXIT

# Wait for the listener to bind. ws://0.0.0.0:PORT becomes connect-able once
# the python coroutine logs its first line, so poll briefly with `nc -z`.
for i in $(seq 1 50); do
  if (echo > /dev/tcp/127.0.0.1/${BRIDGE_PORT}) >/dev/null 2>&1; then
    echo "[robot-mujoco-demo] bridge listening, starting agent..."
    break
  fi
  sleep 0.2
done

cd "${REPO_ROOT}"
MILADY_AINEX_BRIDGE_URL="ws://localhost:${BRIDGE_PORT}" exec bun run dev
