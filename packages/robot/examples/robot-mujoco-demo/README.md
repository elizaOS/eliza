# Eliza ↔ MuJoCo AiNex demo

Drives a simulated Hiwonder AiNex humanoid in MuJoCo by chatting with an Eliza
agent. The agent ships with `@elizaos/plugin-ainex`, which connects to the
Python websocket bridge defined in `packages/robot/eliza_robot/bridge/`.

Two control modes are wired up:

- **Joystick mode** — the agent sends `walk.set` + `walk.command:start` to the
  bridge. The MuJoCo backend applies those velocity targets via the Bezier gait
  controller (`packages/robot/eliza_robot/sim/mujoco/gait/`). This is the
  mechanical mode ported from the original Hiwonder Python code.

- **Trained mode** — the agent sends `policy.start` with a text task
  (`walk_forward`, `shuffle_right`, `wave_to_human`, etc.). The bridge ticks
  the learned policy (`packages/robot/eliza_robot/rl/skills/`) at the
  configured Hz, applies safety clamps, and dispatches resulting joint targets
  to the MuJoCo DemoEnv.

## Prerequisites

```bash
# Python deps (from packages/robot/)
uv sync                     # installs mujoco, websockets, pydantic, pytest...

# elizaOS workspace
bun install                 # from repo root
```

## Run it

### 1. Start the MuJoCo bridge

In one terminal, from the repo root:

```bash
bun run --cwd packages/robot robot:bridge:mujoco
```

This starts the bridge with the MuJoCo CPU backend on `ws://0.0.0.0:9100`.
A target ball spawns at (2.0, 0.0, 0.05) by default — override with
`--mujoco-target-x/-y/-z`.

To run without MuJoCo (lighter, faster startup), swap the script for
`robot:bridge:mock` — the bridge still implements the full protocol and
emits simulated telemetry.

### 2. Start an Eliza agent that loads plugin-ainex

In a second terminal:

```bash
MILADY_AINEX_BRIDGE_URL=ws://localhost:9100 \
  bun run dev
```

`plugin-ainex` auto-enables when `MILADY_AINEX_BRIDGE_URL` is set. Open the
agent UI (default `http://localhost:2138`) and the agent now exposes the
`AINEX_*` action surface.

### 3. Drive the robot

Try these chat prompts:

| Prompt | What happens |
| --- | --- |
| "walk forward" | `AINEX_WALK_FORWARD` → `walk.set(x=0.04)` + `walk.command:start`. The MuJoCo robot starts walking. |
| "stop" | `AINEX_STOP` → `walk.command:stop` (preempt). Robot halts. |
| "turn left then walk forward" | `AINEX_TURN_LEFT` → wait → `AINEX_WALK_FORWARD`. |
| "wave at me" | `AINEX_WAVE` → `action.play(name="wave")`. Right arm plays the bow keyframe sequence. |
| "shuffle right" | `AINEX_SIDE_STEP_RIGHT` → `walk.set(y=-0.03)` + `walk.command:start`. |
| "pick up the red ball" | `AINEX_PICK_UP` → `policy.start(task="pick_up", target_label="red ball")`. Bridge ticks the learned grasp policy until done or max_steps. |

Telemetry flows back as `telemetry.basic` / `telemetry.perception` /
`telemetry.policy` events; the plugin caches the latest snapshot and exposes
it via `AINEX_ROBOT_STATE`, `AINEX_PERCEPTION`, `AINEX_POLICY_STATUS`,
`AINEX_BATTERY` providers so the agent's reasoning has live ground truth.

## What gets exercised

```
agent (chat)
  → @elizaos/plugin-ainex action handler
    → AinexBridgeClient.send(...)
      → ws://localhost:9100
        → bridge server (validation, rate limit, deadman, safety)
          → MuJocoBackend.handle_command(...)
            → DemoEnv (24-DoF AiNex, primitives model)
              ↑
              telemetry events stream back the other way
```

Everything in that path runs on commodity hardware — no GPU required for the
demo. For training (the "trained mode" policies), push the heavy
`packages/robot/eliza_robot/rl/` lifts to a Nebius H200 host per the
package's `AGENTS.md` rule (`JAX_PLATFORMS=cpu` locally only).
