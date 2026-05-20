# @elizaos/plugin-ainex

elizaOS plugin that drives the **Hiwonder AiNex** humanoid robot — and later other humanoids — through a single websocket bridge.

The bridge process (Python, ported from `ainex-robot-code/bridge/`) brokers traffic between the agent and either:

- the **real robot** (servos, IMU, camera, battery), or
- a **MuJoCo simulator** running the same robot profile, or
- a **learned-policy backend** (RL skill, OpenPI VLA, etc.).

This plugin is the thin TypeScript surface the Eliza agent uses to talk to that bridge. Heavy logic (sim, training, gait, perception) lives in `packages/robot/` and its Python sidecar.

## What this plugin gives the agent

- **Actions** (placeholders today; wired up in later waves):
  - `AINEX_WALK_FORWARD`, `AINEX_WALK_BACKWARD`
  - `AINEX_SIDE_STEP_LEFT`, `AINEX_SIDE_STEP_RIGHT`
  - `AINEX_TURN_LEFT`, `AINEX_TURN_RIGHT`
  - `AINEX_STOP`, `AINEX_STAND`, `AINEX_SIT`
  - `AINEX_WAVE`, `AINEX_BOW`
  - `AINEX_PICK_UP`, `AINEX_PLACE_DOWN`
  - `AINEX_SET_SERVO`, `AINEX_RUN_ACTION_GROUP`
- **Providers**:
  - `AINEX_ROBOT_STATE` — current pose, joint angles, IMU, walk-controller state
  - `AINEX_PERCEPTION` — camera frame metadata + bridge-side detections (hands off to plugin-vision)
  - `AINEX_POLICY_STATUS` — active learned-policy lifecycle
  - `AINEX_BATTERY` — voltage and charge state
- **Service** `AinexService` — owns the websocket bridge client connection.

## Environment variables

| Variable                    | Default                | Purpose                                                         |
| --------------------------- | ---------------------- | --------------------------------------------------------------- |
| `MILADY_AINEX_BRIDGE_URL`   | `ws://localhost:9100`  | Websocket URL for the AiNex bridge server.                      |
| `MILADY_AINEX_PROFILE`      | `hiwonder-ainex`       | Robot profile descriptor name to load on the bridge.            |
| `MILADY_AINEX_CAMERA_FPS`   | `10`                   | Frame rate to subscribe to from the robot's camera stream.      |

The plugin auto-enables when `MILADY_AINEX_BRIDGE_URL` is set, or when `features.ainex` is enabled in agent config.

## Related packages

- `packages/robot/` — Python robotics stack (MuJoCo sim, Brax-PPO RL, bridge, perception, trajectory DB) plus a thin TS surface for shared types and re-exports. See [`packages/robot/README.md`](../../packages/robot/README.md).
- `plugins/plugin-vision/` — camera + scene-analysis plugin that will consume the robot camera as a pluggable frame source (W5.1).

## Status

Skeleton only. All actions / providers / the bridge client return placeholder responses until wave W4.1 lands the real bridge client and W4.2 wires the providers + service to live data.
