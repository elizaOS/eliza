# AiNex Unified Bridge

This package supports two websocket API surfaces:

- `bridge.server`: strict command-envelope protocol (`type=command`)
- `bridge.rosbridge_server`: ROSBridge-compatible protocol (`op=publish|subscribe|call_service|...`)

The ROSBridge-compatible endpoint is the primary interface for protocol parity with existing ROSLIB clients and remote-control tooling.

## Targets

- `ros_real`: real AiNex ROS1 stack
- `ros_sim`: ROS simulation stack
- `isaac`: Isaac-target adapter with ROSBridge-compatible control semantics
- `mock`: in-memory development backend

## Quick Start

```bash
cd /home/shaw/Documents/ainex-robot-code
python3 -m venv .venv
source .venv/bin/activate
pip install -r bridge/requirements.txt
```

Verify host runtime prerequisites:

```bash
./bridge/scripts/verify_runtime_env.sh
```

### Command-Envelope Server (existing API)

```bash
PYTHONPATH=. python -m bridge.server --backend ros_real --port 9100
```

With explicit safety and trace logging:

```bash
PYTHONPATH=. python -m bridge.server \
  --backend ros_real \
  --port 9100 \
  --queue-size 256 \
  --max-commands-per-sec 30 \
  --deadman-timeout-sec 1.0 \
  --trace-log-path /tmp/ainex_bridge_trace.jsonl
```

You can also load safety/logging defaults from config:

```bash
PYTHONPATH=. python -m bridge.server \
  --backend ros_real \
  --port 9100 \
  --config bridge/config/default_bridge_config.json
```

### ROSBridge-Compatible Server (protocol parity)

```bash
PYTHONPATH=. python -m bridge.rosbridge_server --backend ros_real --port 9090
```

## ROSBridge-Compatible Operations

Supported websocket ops:

- `subscribe` / `unsubscribe`
- `publish`
- `call_service`
- `advertise` / `unadvertise` (acknowledged)
- `set_level` (acknowledged)

### Key Topics

- `/app/set_walking_param` (`publish`)
- `/app/set_action` (`publish`)
- `/head_pan_controller/command` (`publish`)
- `/head_tilt_controller/command` (`publish`)
- `/ros_robot_controller/bus_servo/set_position` (`publish`)
- `/ros_robot_controller/bus_servo/set_state` (`publish`)
- `/walking/is_walking` (`subscribe`)
- `/ros_robot_controller/battery` (`subscribe`)
- `/imu` (`subscribe`)

### Key Services

- `/walking/command` (`call_service`)
- `/ros_robot_controller/bus_servo/get_position` (`call_service`)
- `/ros_robot_controller/bus_servo/get_state` (`call_service`)

## Startup Scripts

- `bridge/scripts/start_rosbridge_real.sh`
- `bridge/scripts/start_rosbridge_sim.sh`
- `bridge/scripts/start_rosbridge_isaac.sh`
- `bridge/scripts/start_bridge_real.sh`
- `bridge/scripts/start_bridge_sim.sh`

## Isaac Preparation

Use the runbook and URDF export helper:

- `bridge/docs/isaaclab_setup.md`
- `bridge/scripts/prepare_ainex_urdf.sh`

## Safety + Scheduling

Command-envelope mode includes:

- queue-based command execution
- rate limiter (`--max-commands-per-sec`)
- deadman stop (`--deadman-timeout-sec`)

ROSBridge-compatible mode focuses on wire compatibility and backend parity.

## Run Tests

```bash
cd /home/shaw/Documents/ainex-robot-code
PYTHONPATH=. python -m unittest discover -s bridge/tests -p "test_*.py"
```

## Smoke Test (ROSBridge Mode)

```bash
PYTHONPATH=. python3 -m bridge.tools.rosbridge_smoke --uri ws://127.0.0.1:9090
```

## Parity Check (ROSBridge Mode)

```bash
PYTHONPATH=. python3 -m bridge.tools.rosbridge_parity \
  --left-uri ws://127.0.0.1:19091 \
  --right-uri ws://127.0.0.1:19092
```

## ROS Backend Integration Test (Docker)

This runs a real ROS1 runtime in a container, builds required AiNex message packages, launches a ROS harness, and validates the `ros_real` bridge backend end-to-end.

```bash
./bridge/scripts/run_ros_container_integration_test.sh
```

## Full Validation Pass

```bash
./bridge/scripts/run_all_checks.sh
```

