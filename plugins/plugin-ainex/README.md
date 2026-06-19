# @elizaos/plugin-ainex

elizaOS plugin that drives the **Hiwonder AiNex** humanoid robot — and other compatible humanoids — through a websocket bridge. Adds locomotion, servo, action-group, and text-conditioned policy control to any Eliza agent.

## How it works

The bridge process (`python -m eliza_robot.bridge.server`) brokers traffic between the agent and either:

- the **real robot** (servos, IMU, camera, battery), or
- a **MuJoCo simulator** running the same robot profile, or
- a **learned-policy backend** (RL skill, OpenPI VLA, etc.).

This plugin holds the websocket connection to that bridge, caches live telemetry, and exposes agent actions and context providers.

## Capabilities

### Actions

The plugin ships 15 programmatic locomotion actions by default:

| Action | What it does |
|---|---|
| `AINEX_WALK_FORWARD` | Walk forward (continuous until stopped) |
| `AINEX_WALK_BACKWARD` | Walk backward |
| `AINEX_SIDE_STEP_LEFT` | Side-step left |
| `AINEX_SIDE_STEP_RIGHT` | Side-step right |
| `AINEX_TURN_LEFT` | Rotate left in place |
| `AINEX_TURN_RIGHT` | Rotate right in place |
| `AINEX_STOP` | Stop all walking |
| `AINEX_STAND` | Stand upright |
| `AINEX_SIT` | Sit down |
| `AINEX_WAVE` | Wave gesture |
| `AINEX_BOW` | Bow gesture |
| `AINEX_PICK_UP` | Pick-up motion |
| `AINEX_PLACE_DOWN` | Place-down motion |
| `AINEX_SET_SERVO` | Drive one or more servos to target pulse positions |
| `AINEX_RUN_ACTION_GROUP` | Play any named pre-recorded action group from the robot profile |

**Text-conditioned RL policy (opt-in):** Set `ELIZA_AINEX_MODE=rl` to replace the 15 actions with `AINEX_RUN_RL`, which ships free-form natural language instructions to the trained text-conditioned policy on the bridge. Use `ELIZA_AINEX_MODE=both` to expose all 16 actions simultaneously.

### Providers (agent context)

- **`AINEX_ROBOT_STATE`** — current walk velocity, IMU roll/pitch, head pan/tilt
- **`AINEX_PERCEPTION`** — entities detected by the bridge's perception pipeline
- **`AINEX_POLICY_STATUS`** — active learned-policy lifecycle state, task, and step count
- **`AINEX_BATTERY`** — battery voltage (mV) and estimated charge percentage

## Configuration

| Environment variable | Default | Purpose |
|---|---|---|
| `ELIZA_AINEX_BRIDGE_URL` | `ws://localhost:9100` | WebSocket URL for the AiNex bridge server |
| `ELIZA_AINEX_MODE` | `programmatic` | Action surface: `programmatic`, `rl`, or `both` |

`ELIZA_AINEX_BRIDGE_URL` and `ELIZA_AINEX_MODE` are the only settings the plugin reads. (`ELIZA_AINEX_PROFILE` and `ELIZA_AINEX_CAMERA_FPS` are declared as plugin parameters but not consumed here; the active profile is resolved bridge-side.)

## Auto-enable

The plugin enables automatically when `ELIZA_AINEX_BRIDGE_URL` is set in the environment, or when `features.ainex = true` (or `features.ainex.enabled = true`) is present in the agent config. No action is needed if neither condition is met; the plugin stays dormant.

## Starting the bridge

The bridge is a Python process in `packages/robot/`:

```bash
python -m eliza_robot.bridge.server --backend mujoco --port 9100  # MuJoCo simulator
python -m eliza_robot.bridge.server --backend mock --port 9100    # in-memory mock
```

`packages/robot` also ships convenience scripts: `bun run --cwd packages/robot robot:bridge:mujoco` and `robot:bridge:mock`. See `packages/robot/README.md` for the full `--backend` list (mock, mujoco, ros, isaac, ...).

The plugin tolerates a missing bridge at agent startup and recovers automatically when the bridge comes up (exponential-backoff reconnect, 250 ms to 5 s).

## Related packages

- `packages/robot/` — Python robotics stack: MuJoCo simulation, Brax-PPO RL training, bridge server, perception, trajectory database, and shared TypeScript re-exports. See [`packages/robot/README.md`](../../packages/robot/README.md).
- `plugins/plugin-vision/` — camera and scene-analysis plugin that consumes the robot camera as a pluggable frame source.
