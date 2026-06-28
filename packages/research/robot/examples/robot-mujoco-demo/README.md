# Eliza ↔ AiNex (MuJoCo emulator + real robot)

The MuJoCo world is the **emulator** for the real Hiwonder AiNex humanoid.
The plugin/agent speaks ONE protocol; the only thing that differs between
sim and real is the websocket port the agent points at.

```
                                          ws://localhost:9100   (mock)
                                          ws://localhost:9100   (mujoco emulator)
agent  ──  @elizaos/plugin-ainex  ──→     ws://localhost:9100   (ros_sim / Gazebo)
                                          ws://localhost:9100   (ros_real / hardware)
```

Same commands. Same events. Same providers. Same actions. The bridge
server abstracts the backend.

## Mode-switch table

| Target | Backend module | Physics / motors | Camera | Use when |
| --- | --- | --- | --- | --- |
| `mock`   | `MockBackend`     | in-memory state machine | synthetic gradient (changes with yaw + walk state) | iterating on the protocol or the plugin without ROS or MuJoCo |
| `mujoco` | `MuJocoBackend`   | full MuJoCo PD-controlled 24-DoF physics, Bezier gait controller | `DemoEnv.render_ego()` real RGB renders | offline development, regression tests, visual evidence runs |
| `isaac`  | `IsaacBackend`    | IsaacLab simulation | sim camera (when available) | GPU-heavy sim, training rollouts |
| `ros_sim` | `RosBridgeBackend("ros_sim")` | Gazebo via ROS1 | gazebo camera topic | full ROS stack, no hardware |
| `ros_real` | `RosBridgeBackend("ros_real")` | physical AiNex servos | head camera over ROS, plus optional external camera via `--camera-device` | on the real robot |

```bash
# List every available target on this checkout
PYTHONPATH=packages/robot uv run --project packages/robot \
    python -m eliza_robot.bridge.launch --list-targets
```

## Quick start — MuJoCo emulator

```bash
# Terminal 1 — start the MuJoCo bridge on port 9100
bun run --cwd packages/robot robot:bridge:mujoco

# Terminal 2 — launch Eliza with plugin-ainex auto-enabled
ELIZA_AINEX_BRIDGE_URL=ws://localhost:9100 bun run dev
```

The agent now exposes 15 `AINEX_*` actions and 4 `AINEX_*` providers; chat
"walk forward", "stop", "turn around", "wave", "shuffle right" and watch
the MuJoCo render react.

## Quick start — real AiNex

> ⚠ The real robot moves real joints. Always test in a clear space with
> the deadman-timeout in place (default 1 second).

```bash
# On the AiNex Pi (one terminal)
roslaunch ainex_bringup robot.launch

# On your dev box (Terminal 1) — bridge talks ROS1 to the robot
PYTHONPATH=packages/robot uv run --project packages/robot \
    python -m eliza_robot.bridge.launch --target real --envelope

# (optional) replace the head camera with an Obsbot tethered over USB:
PYTHONPATH=packages/robot uv run --project packages/robot \
    python -m eliza_robot.bridge.server \
        --backend ros_real --port 9100 \
        --camera-device 0 --camera-width 1280 --camera-height 720

# Terminal 2 — Eliza, same as the sim quick start
ELIZA_AINEX_BRIDGE_URL=ws://<dev-box-ip>:9100 bun run dev
```

The agent has no idea which target it's pointing at — that's the entire
point of the unified bridge contract.

### Smoke check before the agent

Always run the no-motion smoke harness against the bridge first:

```bash
PYTHONPATH=packages/robot uv run --project packages/robot \
    python packages/robot/scripts/check_real_robot.py \
        --url ws://localhost:9100 --save-frame /tmp/smoke.png
```

The script does **not** move motors. It checks:

1. ws connects + `session.hello`
2. `profile.describe` returns the AiNex profile
3. `camera.snapshot` returns a real frame (writes to `--save-frame`)
4. One `telemetry.basic` arrives with battery + IMU readings

If any of those fail, fix them before sending walking commands.

## Camera setup (Obsbot, v4l2)

Plug the Obsbot in over USB. Confirm enumeration:

```bash
v4l2-ctl --list-devices
# Obsbot ... (usb-...):
#         /dev/video0
#         /dev/video1
```

The bridge's `--camera-device` flag wires the `OpenCVSource` (640×480 by
default, override with `--camera-width/--camera-height`). When set,
`camera.snapshot` reads from the v4l2 device. To force the external
camera regardless of backend, the client requests:

```jsonc
{ "type": "command", "command": "camera.snapshot", "payload": { "camera": "external" } }
```

The Obsbot Tiny/Tail/Meet pan-tilt is driven over USB-HID; the bridge does not
control it yet. Use the manufacturer's app to set the framing.

### Calibration

The camera intrinsics live in `eliza_robot.perception.calibration.CameraIntrinsics`.
Calibrate the Obsbot once with a checkerboard:

```bash
PYTHONPATH=packages/robot python -c '
from eliza_robot.perception.calibration import CameraCalibrator, CameraIntrinsics
from eliza_robot.perception.frame_source import OpenCVSource
import cv2, time
calib = CameraCalibrator(board_size=(8, 6), square_size_mm=14.3)
with OpenCVSource(device=0, width=1280, height=720) as src:
    for i in range(40):
        ok, frame = src.read()
        if not ok: break
        added = calib.add_image(frame)
        if added:
            print(f"image {calib.num_images} captured")
        time.sleep(0.5)
intrinsics, rms = calib.calibrate()
print(f"reprojection RMS = {rms:.3f}")
intrinsics.save_yaml(Path("obsbot_calibration.yaml"))
'
```

Then point the perception pipeline at the saved YAML.

## ArUco localization

The local repo has `eliza_robot.perception.detectors.aruco_detector` and
the world-frame marker layout from
`eliza_robot.perception.configs.demo_aruco.yaml`:

| ID | Role | World position (m) |
| --- | --- | --- |
| 0 | Robot Body | — (attached to chest/back) |
| 1 | Robot Head | — (attached to forehead) |
| 2 | Ground Origin | (0, 0, 0) |
| 3 | Ground +X | (1, 0, 0) |
| 4 | Ground +X +Y | (1, 1, 0) |
| 5 | Ground +Y | (0, 1, 0) |
| 6 | Object: Red Ball | — |
| 7 | Object: Blue Cube | — |
| 8 | Object: Green Cylinder | — |

Print the markers from `printables/aruco/*.png` (on the SSD —
`/media/shaw/Extreme SSD/hyperscape-robot-workspace/printables/aruco/`)
at 2 inches (50.8 mm) and place them flat on the floor matching the
table. Run the integration script:

```bash
PYTHONPATH=packages/robot uv run --project packages/robot \
    python packages/robot/scripts/evidence_aruco_localize.py \
        --out /tmp/aruco_evidence/
```

For the **real** Obsbot, modify the script to swap the MuJoCo bridge for
the real one and use `camera.snapshot { camera: "external" }` — the
detector is identical.

## Visual verification — the 180° turn

The reference run is checked in at `evidence/`. Reproduce it with:

```bash
PYTHONPATH=packages/robot uv run --project packages/robot \
    python packages/robot/scripts/evidence_turn_180.py \
        --yaw-rate -8.0 --duration 2.5
```

The script returns exit code 0 only if:

- Mean per-pixel absolute diff between before/after head-camera frames > 1.0.
- Ground-truth yaw delta (read directly from `DemoEnv.get_robot_yaw()`) > 30°.

Last green run: yaw -154.72°, mean pixel diff 44.93, 99.99% of pixels
changed. See `evidence/INDEX.md` for the full artifact map.

For the **real robot** equivalent, run the script against the `ros_real`
target and the Obsbot:

```bash
# 1. Park the robot on a clear surface, head pointing at a feature-rich background
# 2. Start the bridge with Obsbot camera attached
PYTHONPATH=packages/robot uv run --project packages/robot \
    python -m eliza_robot.bridge.server --backend ros_real --port 9100 \
        --camera-device 0 --camera-width 1280 --camera-height 720
# 3. Run the evidence script — it sends walk commands at -3.5 rad/s for 1s
PYTHONPATH=packages/robot uv run --project packages/robot \
    python packages/robot/scripts/evidence_turn_180.py \
        --yaw-rate -3.5 --duration 1.0 \
        --out /tmp/real_turn_evidence/
# Compare /tmp/real_turn_evidence/before.png and after.png
```

The script's yaw-delta check needs to be replaced with an external
ground-truth source on the real robot — the IMU yaw, an ArUco-tagged
overhead camera, or vicon if you have it.

## Text-conditioned policies

`AINEX_PICK_UP`, `AINEX_PLACE_DOWN`, and any custom learned skill route
through `policy.start` with a `task` string. The bridge looks the task up
in the skill registry (`eliza_robot.rl.skills.registry.SkillRegistry`),
parses ambiguous phrases through `CommandParser` (regex + embedding
fallback), and ticks the policy at the requested Hz.

Test the parser without the agent:

```bash
PYTHONPATH=packages/robot uv run --project packages/robot \
    python -c '
from eliza_robot.rl.meta.command_parser import CommandParser
p = CommandParser()
for phrase in ["walk forward fast", "shuffle to the right", "turn around", "say hello"]:
    r = p.parse(phrase)
    print(f"{phrase!r:35s} -> {r.skill_name} (confidence={r.confidence:.2f})")
'
```

## What is genuinely verified by the test suite

- ✅ TS plugin → bridge ws roundtrip (`plugins/plugin-ainex/test/`).
- ✅ Bridge unified contract (`tests/bridge/test_unified_contract.py`).
- ✅ Camera snapshot returns a valid PNG with width/height
  (`tests/bridge/test_camera_snapshot*.py`).
- ✅ Walk commands change `DemoEnv` joint state and the head render
  changes (`tests/bridge/test_camera_snapshot_mujoco.py`).
- ✅ Yaw command rotates the robot >150° in 2.5 s, head render diff
  → 100% pixels changed (`scripts/evidence_turn_180.py` + `evidence/`).
- ✅ Joystick mode (`walk.set` / `walk.command`) and trained mode
  (`policy.start` / `policy.tick`) both work over the same protocol
  (`tests/bridge/test_two_modes.py`).
- ✅ Manual command preempts an active policy
  (`tests/bridge/test_two_modes.py`).
- ✅ ArUco detection + 6-DoF pose recovery against real MuJoCo renders
  (`tests/perception/test_aruco_bridge_integration.py`).
- ✅ Text-conditioned command parser routes chat phrases to skills
  (`tests/rl/test_text_conditioned_pipeline.py`).

## What still needs physical hardware to verify

The bridge contract is the same for sim and real. The remaining
unknowns require the AiNex to actually be on:

- Real motor PD response under the bezier gait (the sim gait controller
  is provisional, not the tuned Hiwonder one).
- Obsbot v4l2 enumeration on your specific host (try `--camera-device 0`
  first; if no frame, try 1, 2, …).
- Real-robot yaw measurement source. The evidence script reads
  `DemoEnv.get_robot_yaw()` in sim; on hardware you need an IMU,
  external ArUco tracker, or motion capture.
- Camera intrinsics for the Obsbot (run the calibration block above
  once, save the YAML, point the perception pipeline at it).

## Follow-up surfaced by this round

- Native bezier-gait → MuJoCo joint targets is not tuned for the real
  AiNex servo dynamics. Replace with the trained RL walk policy
  checkpoint once it lands.
- The bridge has no PTZ control for Obsbot; add an `obsbot.set` command
  or expose `head.set` semantics through the Obsbot SDK.
- `camera.frame` streaming (vs. snapshot polling) for higher fps over
  the bridge — currently the plugin polls.
