# @elizaos/robot

Python robotics stack (MuJoCo sim, Alberta continual-RL training, Brax/MJX
baselines, websocket bridge, perception, trajectory DB) with a thin TypeScript
surface for re-exports and shared schemas. Drives simulated and real robots via
profile-driven configuration; the first shipping profile is **Hiwonder AiNex**.

## Who consumes this

The heavy logic lives in the Python package `eliza_robot`. The TypeScript
`src/` directory is a thin surface (`RobotProfileId`, `ROBOT_PACKAGE_VERSION`)
imported by `@elizaos/plugin-ainex`, the elizaOS plugin that drives real and
simulated robots.

Multi-robot support is profile-driven: every joint spec, asset bundle,
calibration, gait, and bridge configuration is keyed by `RobotProfileId` and
resolved through `load_profile(profile_id)`. Profile manifests live under
`profiles/<id>/` and binary assets under `assets/profiles/<id>/`. Deployments
can mount those separately via `ELIZA_ROBOT_PROFILES_ROOT` and
`ELIZA_ROBOT_ASSETS_ROOT`.

## Layout

```
src/                    TS surface (index.ts re-exports ROBOT_PACKAGE_VERSION + types.ts)
eliza_robot/            Python package (pip: eliza-robot) — all robotics logic
  bridge/               Websocket server (server.py) + backends/ (mock, mujoco, ros, isaac, ainex_remote)
  sim/mujoco/           MJX scenes, env wrappers, sim_loop entry point
  rl/                   RL trainers: alberta/ (continual RL), text_conditioned/, skills/
  perception/           Camera frames, detectors, SLAM, world model
  trajectory_db/        SQLite-backed trajectory store
  profiles/             Profile loader (__init__.py) + RobotProfile schema (schema.py)
  schema/               Canonical constants + adapters
  asimov_1/             ASIMOV-1 integration
profiles/<id>/          Per-robot profile manifests (hiwonder-ainex, unitree-g1/h1/r1, asimov-1, erobot)
assets/profiles/<id>/   Per-profile binaries (URDF/STL/MJCF XML)
tests/                  pytest suite
docs/                   Architecture notes
```

ASIMOV-1 integration details live in
[`docs/asimov-1.md`](./docs/asimov-1.md). Alberta training readiness and
validation evidence live in
[`docs/ALBERTA_PRODUCTION_READINESS.md`](./docs/ALBERTA_PRODUCTION_READINESS.md).
Alberta continual-RL design notes:
[`eliza_robot/rl/alberta/README.md`](./eliza_robot/rl/alberta/README.md).

## Commands

```bash
# From this package directory:
bun run robot:bridge:mock     # bridge against the mock backend (port 9100)
bun run robot:bridge:mujoco   # bridge against the MuJoCo simulator (port 9100)
bun run robot:demo            # voice + sim demo (examples/robot-mujoco-demo)
bun run build                 # tsdown — emit dist/
bun run typecheck             # tsgo --noEmit
bun run test                  # vitest run + pytest shim
bun run test:py               # uv run pytest tests/ -q

# Python direct (requires uv):
uv run pytest tests/ -q
uv run python -m eliza_robot.bridge.server --backend mock --port 9100
uv run eliza-robot-train --profile hiwonder-ainex --steps 30000
uv run eliza-robot-train-alberta --profile hiwonder-ainex
uv run eliza-robot-benchmark-alberta --steps-per-task 16000 --seeds 3
```

## Config

| Variable | Purpose |
|---|---|
| `ELIZA_ROBOT_PROFILES_ROOT` | Override profiles manifest dir (default `profiles/`) |
| `ELIZA_ROBOT_ASSETS_ROOT` | Override binary assets dir (default `assets/profiles/`) |
| `JAX_PLATFORMS` | Set to `cpu` to force CPU JAX locally |

## Conventions

- Never run heavy GPU work locally — push training to Nebius. Force CPU JAX with
  `JAX_PLATFORMS=cpu`.
- Profiles are first-class: every codepath that touches a robot accepts a
  `RobotProfileId` and resolves config via `load_profile`. No hardcoded robot names.
- Python `>=3.12,<3.13` (Alberta framework uses PEP 695 syntax). Use `uv` for all
  Python commands. `numpy<2` is pinned for Brax/MuJoCo/JAX ABI compatibility.
- Do not commit `checkpoints/`, videos, calibration data, or large `*.npz`. The CI
  gate at `scripts/check-no-large-binaries.sh` fails any tracked file over 5 MB
  outside known asset dirs.

See [`AGENTS.md`](./AGENTS.md) for the full agent contract.
</content>
</invoke>
