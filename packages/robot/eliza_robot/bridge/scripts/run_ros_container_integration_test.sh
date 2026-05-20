#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK_DIR="$ROOT_DIR/.tmp_ros_test_ws"
mkdir -p "$WORK_DIR"

docker run --rm --network host \
  -v "$ROOT_DIR:/work/ainex-robot-code" \
  -w /work/ainex-robot-code \
  ros:noetic-ros-base \
  bash -lc '
    set -euo pipefail
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y python3-pip
    pip3 install --no-input websockets

    mkdir -p /tmp/ainex_ws/src
    cp -r /work/ainex-robot-code/ros_ws_src/ainex_interfaces /tmp/ainex_ws/src/
    cp -r /work/ainex-robot-code/ros_ws_src/ainex_driver/ros_robot_controller /tmp/ainex_ws/src/
    cp -r /work/ainex-robot-code/ros_ws_src/third_party/ros-sensor_msgs_ext /tmp/ainex_ws/src/sensor_msgs_ext

    source /opt/ros/noetic/setup.bash
    cd /tmp/ainex_ws
    catkin_make
    source /tmp/ainex_ws/devel/setup.bash
    cd /work/ainex-robot-code
    export PYTHONPATH=/work/ainex-robot-code:${PYTHONPATH:-}

    roscore >/tmp/bridge-roscore.log 2>&1 &
    ROSCORE_PID=$!
    sleep 2

    python3 -m bridge.tools.ros_runtime_harness >/tmp/bridge-harness.log 2>&1 &
    HARNESS_PID=$!
    sleep 2

    python3 -m bridge.rosbridge_server --backend ros_real --host 127.0.0.1 --port 19095 --publish-hz 20.0 >/tmp/bridge-server.log 2>&1 &
    SERVER_PID=$!
    sleep 2

    set +e
    python3 -m bridge.tools.rosbridge_smoke --uri ws://127.0.0.1:19095
    TEST_EXIT=$?
    set -e

    kill $SERVER_PID || true
    kill $HARNESS_PID || true
    kill $ROSCORE_PID || true

    if [[ "$TEST_EXIT" -ne 0 ]]; then
      echo "===== /tmp/bridge-server.log ====="
      cat /tmp/bridge-server.log || true
      echo "===== /tmp/bridge-harness.log ====="
      cat /tmp/bridge-harness.log || true
      echo "===== /tmp/bridge-roscore.log ====="
      cat /tmp/bridge-roscore.log || true
    fi

    exit "$TEST_EXIT"
  '

echo "ros_container_integration=PASS"
