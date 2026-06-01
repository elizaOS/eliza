# @elizaos/plugin-ainex

Drives Hiwonder AiNex (and other) humanoid robots via a websocket bridge; integrates camera into plugin-vision and exposes locomotion, servo, and action-group control to an Eliza agent.

## Purpose / role

This plugin is the TypeScript agent surface for the AiNex robot bridge. It manages a persistent websocket connection to the bridge process (`python -m eliza_robot.bridge.server`), caches live telemetry for providers, and exposes 15 programmatic actions (or a single text-conditioned RL action) that the agent calls to move and pose the robot. Auto-enables when `ELIZA_AINEX_BRIDGE_URL` is set or when `features.ainex` is enabled in agent config.

## Plugin surface

### Service

- **`AinexService`** (`src/service.ts`) — singleton service (`serviceType = "ainex"`). Opens `AinexBridgeClient`, loads the robot profile via `profile.describe`, caches `BasicTelemetrySnapshot`, `PerceptionSnapshot`, `PolicyStatusSnapshot`, and `SafetySnapshot` from incoming bridge events. Exposes `getBridge()`, `getProfile()`, `getTelemetry()`, `getPerception()`, `getPolicyStatus()`, `getSafety()`, `snapshotCamera()`.

### Actions (default: 15 programmatic, `ELIZA_AINEX_MODE=programmatic`)

| Action name | Bridge command(s) | Description |
|---|---|---|
| `AINEX_WALK_FORWARD` | `walk.set` + `walk.command:start` | Walk forward |
| `AINEX_WALK_BACKWARD` | `walk.set` + `walk.command:start` | Walk backward |
| `AINEX_SIDE_STEP_LEFT` | `walk.set` + `walk.command:start` | Side-step left |
| `AINEX_SIDE_STEP_RIGHT` | `walk.set` + `walk.command:start` | Side-step right |
| `AINEX_TURN_LEFT` | `walk.set` + `walk.command:start` | Turn left in place |
| `AINEX_TURN_RIGHT` | `walk.set` + `walk.command:start` | Turn right in place |
| `AINEX_STOP` | `walk.command:stop` | Stop walking |
| `AINEX_STAND` | `action.play` → `stand` | Stand upright |
| `AINEX_SIT` | `action.play` → `sit` | Sit down |
| `AINEX_WAVE` | `action.play` → `wave` | Wave |
| `AINEX_BOW` | `action.play` → `bow` | Bow |
| `AINEX_PICK_UP` | `action.play` → `pick_up` | Pick-up motion |
| `AINEX_PLACE_DOWN` | `action.play` → `place_down` | Place-down motion |
| `AINEX_SET_SERVO` | `servo.set` | Drive one or more servos to target pulse positions |
| `AINEX_RUN_ACTION_GROUP` | `action.play` | Play a named pre-recorded action group from the profile |

**RL / text-conditioned action (opt-in, `ELIZA_AINEX_MODE=rl`):**
- `AINEX_RUN_RL` — ships `options.text` as `policy.start { task }` to the trained text-conditioned policy.

Use `selectActions(runtime)` from `src/actions/index.ts` to resolve the surface from `ELIZA_AINEX_MODE`.

### Providers

- **`AINEX_ROBOT_STATE`** — walk velocity, IMU roll/pitch, head pan/tilt from `BasicTelemetrySnapshot`.
- **`AINEX_PERCEPTION`** — labelled entities detected by the bridge's perception pipeline (`PerceptionSnapshot`).
- **`AINEX_POLICY_STATUS`** — active learned-policy lifecycle state/task/step (`PolicyStatusSnapshot`).
- **`AINEX_BATTERY`** — battery mV and estimated charge percentage (`BasicTelemetrySnapshot.battery_mv`).

## Layout

```
src/
  index.ts              Plugin export + ainexPlugin object + autoEnable logic
  service.ts            AinexService — bridge lifecycle, telemetry caches
  bridge-client.ts      AinexBridgeClient — WebSocket, send(), on(), auto-reconnect
  types.ts              Wire-protocol types (CommandEnvelope, ResponseEnvelope,
                        EventEnvelope, BridgeCommand, BridgeEvent, RobotProfileDescriptor)
  profile-schema.ts     Zod schemas + loadProfileFromBridge() / parseRobotProfileDescriptor()
  actions/
    _helpers.ts         getService(), getBridge(), sendOne(), startWalking(), notConnected()
    index.ts            PROGRAMMATIC_ACTIONS array, selectActions()
    walkForward.ts      AINEX_WALK_FORWARD
    walkBackward.ts     AINEX_WALK_BACKWARD
    sideStepLeft.ts     AINEX_SIDE_STEP_LEFT
    sideStepRight.ts    AINEX_SIDE_STEP_RIGHT
    turnLeft.ts         AINEX_TURN_LEFT
    turnRight.ts        AINEX_TURN_RIGHT
    stop.ts             AINEX_STOP
    stand.ts            AINEX_STAND
    sit.ts              AINEX_SIT
    wave.ts             AINEX_WAVE
    bow.ts              AINEX_BOW
    pickUp.ts           AINEX_PICK_UP
    placeDown.ts        AINEX_PLACE_DOWN
    setServo.ts         AINEX_SET_SERVO
    runActionGroup.ts   AINEX_RUN_ACTION_GROUP
    runRl.ts            AINEX_RUN_RL (opt-in)
  providers/
    index.ts            providers array
    robotState.ts       AINEX_ROBOT_STATE
    perception.ts       AINEX_PERCEPTION
    policyStatus.ts     AINEX_POLICY_STATUS
    battery.ts          AINEX_BATTERY
```

## Commands

```bash
bun run --cwd plugins/plugin-ainex build      # tsdown build → dist/
bun run --cwd plugins/plugin-ainex typecheck  # tsgo --noEmit
bun run --cwd plugins/plugin-ainex test       # vitest run
bun run --cwd plugins/plugin-ainex clean      # rm dist/ .turbo/
```

## Config / env vars

| Var | Required | Default | Purpose |
|---|---|---|---|
| `ELIZA_AINEX_BRIDGE_URL` | triggers auto-enable | `ws://localhost:9100` | WebSocket URL for the bridge server |
| `ELIZA_AINEX_PROFILE` | no | `hiwonder-ainex` | Profile descriptor name to resolve on the bridge |
| `ELIZA_AINEX_CAMERA_FPS` | no | `10` | Camera frame rate for subscription |
| `ELIZA_AINEX_MODE` | no | `programmatic` | Action surface: `programmatic` (15 actions), `rl` (AINEX_RUN_RL only), `both` |

All vars are read via `runtime.getSetting()`. Plugin auto-enables if `ELIZA_AINEX_BRIDGE_URL` is set OR `features.ainex = true` in agent config.

## How to extend

**Add an action:**
1. Create `src/actions/<name>.ts` exporting a `const <name>Action: Action`.
2. Use `sendOne()` or `startWalking()` from `_helpers.ts` for the bridge call.
3. Add to the `PROGRAMMATIC_ACTIONS` array in `src/actions/index.ts` and re-export.

**Add a provider:**
1. Create `src/providers/<name>.ts` exporting a `const <name>Provider: Provider`.
2. Read state from `AinexService` via `runtime.getService<AinexService>(AinexService.serviceType)`.
3. Add to the `providers` array in `src/providers/index.ts`.

**Add a telemetry event handler:**
1. Add the event name to `BridgeEvent` in `src/types.ts`.
2. Register a handler in `AinexService._registerEventHandlers()` and add a private `_on<Event>()` method.

## Conventions / gotchas

- **Wire types must stay in sync with Python.** `src/types.ts` mirrors `packages/robot/eliza_robot/profiles/schema.py` and `bridge/protocol.py`. Any field rename on the Python side must be reflected here.
- **Bridge is optional at startup.** `AinexService._tryConnect()` logs a warning but does not throw if the bridge is unreachable. Providers return `"(ainex not connected)"` until connected; actions error loudly.
- **Auto-reconnect is on by default.** `AinexBridgeClient` uses exponential backoff (250 ms initial, 5 s cap). Pending `send()` calls fail-fast on disconnect; retry at the action layer if needed.
- **Camera snapshots are pull-only.** Call `AinexService.snapshotCamera(camera?)` for a single PNG frame. There is no push/stream subscription in this plugin; plugin-vision handles streaming.
- **Node.js only.** `platform: "node"` in `package.json`. The `ws` package is a Node dependency; this plugin does not run in browsers or Bun native WebSocket.
- **`AINEX_RUN_RL` is not in the default action list.** It must be opted into via `ELIZA_AINEX_MODE=rl` or `ELIZA_AINEX_MODE=both`.
