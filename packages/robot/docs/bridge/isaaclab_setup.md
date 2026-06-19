# Isaac Sim + IsaacLab Setup for AiNex

This runbook covers end-to-end setup: from prerequisites through asset pipeline to running a ROSBridge-compatible websocket endpoint for agent control.

## 1) Prerequisites

| Requirement | Minimum | Recommended |
|------------|---------|-------------|
| OS | Ubuntu 22.04 | Ubuntu 22.04 |
| GPU VRAM | 8 GB | 16 GB |
| NVIDIA Driver | 535+ | Latest |
| CUDA | 12.1+ | 12.4+ |
| Python | 3.10 | 3.10 |
| Isaac Sim | 4.2.0 | 4.5.0 |
| IsaacLab | 2.0.0 | 2.1.0 |

Version pins are tracked in `bridge/config/isaaclab_versions.json`.

Check prerequisites:

```bash
nvidia-smi              # GPU driver and VRAM
nvcc --version          # CUDA toolkit
python3 --version       # Python version
```

## 2) Environment Setup

```bash
./bridge/scripts/setup_isaac_env.sh
```

This creates a virtual environment and installs bridge dependencies. Follow the on-screen instructions for Isaac Sim and IsaacLab installation.

## 3) Export AiNex URDF from xacro

```bash
./bridge/scripts/prepare_ainex_urdf.sh
```

Generates:
- `bridge/generated/ainex.urdf` — standalone URDF with patched mesh paths
- `bridge/generated/meshes/` — copied STL mesh files

Source: `ros_ws_src/ainex_simulations/ainex_description/urdf/ainex.xacro`

## 4) Validate Robot Model

```bash
PYTHONPATH=. python -m bridge.isaaclab.validate_model
```

Checks:
- All 24 revolute joints present with correct limits
- Link masses are physically reasonable
- Mesh references resolve
- Standing pose is valid

## 5) Convert URDF to USD

In the Isaac-enabled Python environment:

```bash
PYTHONPATH=. python -m bridge.isaaclab.convert_urdf_to_usd
```

Or validate only:

```bash
PYTHONPATH=. python -m bridge.isaaclab.convert_urdf_to_usd --validate-only
```

Output: `bridge/generated/ainex.usd`

## 6) Test IsaacLab Configuration

Dry-run (no Isaac Sim required):

```bash
PYTHONPATH=. python -m bridge.isaaclab.run_sim --dry-run
```

Full simulation (requires Isaac Sim):

```bash
PYTHONPATH=. python -m bridge.isaaclab.run_sim
PYTHONPATH=. python -m bridge.isaaclab.run_sim --headless
```

## 7) Start Bridge

### Unified Launcher

```bash
# Isaac backend (default)
PYTHONPATH=. python -m bridge.launch --target isaac

# Real robot
PYTHONPATH=. python -m bridge.launch --target real

# Gazebo simulation
PYTHONPATH=. python -m bridge.launch --target sim

# Development mock
PYTHONPATH=. python -m bridge.launch --target mock

# List all targets
PYTHONPATH=. python -m bridge.launch --list-targets
```

### Convenience Scripts

```bash
./bridge/scripts/start_rosbridge_isaac.sh   # Isaac backend
./bridge/scripts/start_rosbridge_real.sh    # Real robot
./bridge/scripts/start_rosbridge_sim.sh     # Gazebo sim
./bridge/scripts/start_rosbridge_mock.sh    # Mock backend
```

All expose ROSBridge-compatible websocket on `ws://<host>:9090`.

### Environment Overrides

| Variable | Description |
|----------|-------------|
| `AINEX_BRIDGE_HOST` | Listen host (default: 0.0.0.0) |
| `AINEX_ROSBRIDGE_PORT` | ROSBridge port (default: 9090) |
| `AINEX_ENVELOPE_PORT` | Command-envelope port (default: 9100) |
| `AINEX_PUBLISH_HZ` | Telemetry publish rate |
| `AINEX_MAX_CMD_SEC` | Rate limit (commands/sec) |
| `AINEX_DEADMAN_SEC` | Deadman timeout (seconds) |

## 8) Run Tests

```bash
# All unit and integration tests
PYTHONPATH=. python -m unittest discover -s bridge/tests -p "test_*.py"

# Specific test suites
PYTHONPATH=. python -m unittest bridge.tests.test_rosbridge_contract
PYTHONPATH=. python -m unittest bridge.tests.test_backend_parity
PYTHONPATH=. python -m unittest bridge.tests.test_isaac_backend
PYTHONPATH=. python -m unittest bridge.tests.test_joint_map
PYTHONPATH=. python -m unittest bridge.tests.test_ainex_cfg
PYTHONPATH=. python -m unittest bridge.tests.test_actions
PYTHONPATH=. python -m unittest bridge.tests.test_sim_state
```

Smoke test against a running endpoint:

```bash
PYTHONPATH=. python -m bridge.tools.rosbridge_smoke --uri ws://127.0.0.1:9090
```

Parity check between two endpoints:

```bash
PYTHONPATH=. python -m bridge.tools.rosbridge_parity \
  --left-uri ws://127.0.0.1:9090 \
  --right-uri ws://127.0.0.1:9091
```

## 9) Endpoint Swap Acceptance Checklist

To verify "drop-in endpoint swap" between targets:

- [ ] Same websocket client connects to both `real` and `isaac` endpoints
- [ ] `subscribe` to `/ros_robot_controller/battery` returns data on both
- [ ] `call_service` to `/walking/command` with `start`/`stop` succeeds on both
- [ ] `publish` to `/app/set_walking_param` accepted on both
- [ ] `publish` to `/head_pan_controller/command` accepted on both
- [ ] `call_service` to `/ros_robot_controller/bus_servo/get_position` returns positions on both
- [ ] `publish` to `/ros_robot_controller/bus_servo/set_position` accepted on both
- [ ] `get_time` returns valid secs/nsecs on both
- [ ] `advertise` acknowledged on both
- [ ] Error responses preserve request IDs on both
- [ ] Rate limiting activates at configured threshold
- [ ] Deadman timeout issues auto-stop after inactivity

## 10) Network Topology

```
┌─────────────────┐     ws://host:9090     ┌──────────────────┐
│  ML Agent /      │ ──────────────────────▶ │  ROSBridge        │
│  Web Client      │ ◀────────────────────── │  Websocket Server │
└─────────────────┘     (bidirectional)     └────────┬─────────┘
                                                      │
                                             ┌────────┴─────────┐
                                             │  Target Router    │
                                             └──┬────┬────┬─────┘
                                                │    │    │
                               ┌────────────────┘    │    └───────────────┐
                               ▼                     ▼                    ▼
                        ┌──────────┐          ┌──────────┐         ┌──────────┐
                        │ Real     │          │ Gazebo   │         │ IsaacLab │
                        │ Robot    │          │ Sim      │         │ Sim      │
                        │ (ROS1)   │          │ (ROS1)   │         │ (USD)    │
                        └──────────┘          └──────────┘         └──────────┘
```
