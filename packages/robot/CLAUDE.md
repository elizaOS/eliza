# @elizaos/robot

Python robotics stack (MuJoCo sim, Alberta continual-RL training, Brax/MJX baselines, websocket bridge, perception, trajectory DB) with a thin TypeScript surface for re-exports and shared schemas. Drives simulated and real robots via profile-driven configuration; first profile is Hiwonder AiNex.

## Purpose / role

This package owns the full Python robotics pipeline and exposes a minimal TS surface (`RobotProfileId`, `ROBOT_PACKAGE_VERSION`) consumed by `@elizaos/plugin-ainex` (the elizaOS plugin that drives real and simulated robots). It does NOT own the Eliza plugin surface (that is `plugins/plugin-ainex/`), vision pipeline orchestration (`plugins/plugin-vision/`), or the voice pipeline (`packages/inference/`).

## Layout

```
src/                    TS surface — entry: src/index.ts
  index.ts              Re-exports ROBOT_PACKAGE_VERSION + types
  types.ts              RobotProfileId (string alias)

eliza_robot/            Python package (pip: eliza-robot)
  __init__.py           Top-level re-exports: RobotProfile, list_profiles, load_profile, ...
  bridge/               Websocket server (robot ↔ runtime)
    server.py           asyncio websocket server; --backend mock|mujoco|ros|isaac
    protocol.py         CommandEnvelope, EventEnvelope, ResponseEnvelope, parse_command
    safety.py           CommandRateLimiter, PolicyHeartbeatMonitor, motion-bounds check
    backends/           BridgeBackend ABC + concrete backends (mock, mujoco, ros, isaac)
    validation.py       validate_command_payload
    types.py            JsonDict / JsonValue aliases
  sim/
    mujoco/             MJX scenes, env wrappers, sim_loop entry point
  rl/
    alberta/            Alberta continual-RL trainer (streaming, no catastrophic forgetting)
      train_robot.py    CLI entry → eliza-robot-train-alberta
      benchmark.py      CLI entry → eliza-robot-benchmark-alberta
    text_conditioned/   Text-conditioned multi-task RL; train.py → eliza-robot-train
    locomotion_metrics.py
  perception/           Camera frames, ASR, ONNX inference, SLAM, world model
  trajectory_db/        SQLite-backed trajectory store (db.py, models.py, schema.py)
  profiles/             Profile loader (__init__.py = load_profile/list_profiles/DEFAULT_PROFILE_ID)
    schema.py           RobotProfile Pydantic v2 model (canonical source of truth)
  asimov_1/             ASIMOV-1 integration (CAD edit loop, MuJoCo assets, bridge targets)
  schema/               AiNex canonical constants and adapters (canonical.py, embodied_context.py, hyperscape_adapter.py)

profiles/               Per-robot profile manifests (profile.yaml + per-profile config)
  hiwonder-ainex/
  unitree-g1/
  unitree-h1/
  unitree-r1/
  asimov-1/
  erobot/
assets/                 Binary assets (URDF, STL, MJCF XML) — never commit large blobs
  profiles/<id>/        Per-profile binaries
scripts/                CLI helpers and CI gates (e.g. check-no-large-binaries.sh)
tests/                  pytest suite
docs/                   Architecture notes (asimov-1.md, ALBERTA_PRODUCTION_READINESS.md, SSD_PORT_ASSESSMENT.md)
examples/               robot-mujoco-demo/ run.sh
checkpoints/            (gitignored) RL training output
```

## Key exports / surface

**TypeScript (`@elizaos/robot`):**

```ts
import { RobotProfileId, ROBOT_PACKAGE_VERSION } from "@elizaos/robot";
```

- `RobotProfileId` — `string` alias for a profile key (e.g. `"hiwonder-ainex"`).
- `ROBOT_PACKAGE_VERSION` — package version constant.

**Python (`eliza_robot`):**

```python
from eliza_robot import RobotProfile, load_profile, list_profiles, DEFAULT_PROFILE_ID
from eliza_robot.profiles.schema import JointSpec, GaitParams, SafetyLimits, ActionLibrary
```

`load_profile(profile_id)` is the single entry point for all robot-specific config. Every code path that touches a robot MUST resolve config via this function — no hardcoded `if robot == "ainex"` branches.

**Python CLI entry points (from pyproject.toml):**

| Entry point | Module |
|---|---|
| `eliza-robot-sim` | `eliza_robot.sim.mujoco.sim_loop:main` |
| `eliza-robot-bridge` | `eliza_robot.bridge.server:main` |
| `eliza-robot-train` | `eliza_robot.rl.text_conditioned.train:main` |
| `eliza-robot-train-alberta` | `eliza_robot.rl.alberta.train_robot:main` |

## Commands

```bash
# Bridge (Python sidecar)
bun run --cwd packages/robot robot:bridge:mock     # mock backend, port 9100
bun run --cwd packages/robot robot:bridge:mujoco   # MuJoCo backend, port 9100
bun run --cwd packages/robot robot:demo            # voice + sim demo

# TS surface
bun run --cwd packages/robot build         # tsdown — emit dist/
bun run --cwd packages/robot typecheck     # tsgo --noEmit
bun run --cwd packages/robot lint          # biome check --write
bun run --cwd packages/robot test          # vitest run + pytest shim

# Python direct (requires uv)
uv run pytest tests/ -q
uv run python -m eliza_robot.bridge.server --backend mock --port 9100
uv run eliza-robot-train --profile hiwonder-ainex --steps 30000
uv run eliza-robot-train-alberta --profile hiwonder-ainex
uv run eliza-robot-benchmark-alberta --steps-per-task 16000 --seeds 3
```

## Config / env vars

| Variable | Purpose | Default |
|---|---|---|
| `ELIZA_ROBOT_PROFILES_ROOT` | Override profiles manifest dir | `profiles/` in package root |
| `ELIZA_ROBOT_ASSETS_ROOT` | Override binary assets dir | `assets/profiles/` in package root |
| `JAX_PLATFORMS` | Force CPU JAX locally | Set to `cpu` for local dev |

## How to extend

**Add a new robot profile:**

1. Create `profiles/<id>/profile.yaml` following the `RobotProfile` Pydantic schema in `eliza_robot/profiles/schema.py`.
2. Add binary assets under `assets/profiles/<id>/` (MJCF/URDF/STL).
3. `load_profile("<id>")` resolves automatically — no code changes needed unless the robot needs a new bridge backend.

**Add a new bridge backend:**

1. Subclass `eliza_robot.bridge.backends.base.BridgeBackend` (implement `connect`, `shutdown`, `handle_command`, `poll_events`, `capabilities`; optionally `snapshot_camera`).
2. Register it in `eliza_robot.bridge.server` backend dispatch map.
3. Add `--backend <name>` to the argument parser.

**Add a TS export:**

1. Add the type/value to `src/types.ts` or `src/index.ts`.
2. Re-run `bun run --cwd packages/robot build` to emit updated `dist/`.

## Conventions / gotchas

- **Compute discipline:** Never run heavy GPU work locally. Train on Nebius. Local runs MUST default to `JAX_PLATFORMS=cpu`; scripts that need GPU must fail loud, not fall back silently.
- **Profiles are first-class:** Every function that touches a robot accepts `RobotProfileId`. No hardcoded robot names anywhere in the stack.
- **Safety failures must be loud:** Do NOT catch-and-continue on calibration or safety failures. Robots cause damage when guarded by silent fallbacks.
- **Python runtime:** Requires Python `>=3.12,<3.13` (Alberta framework uses PEP 695 syntax). Use `uv` for all Python commands.
- **alberta-framework:** Resolved from the repo-local `packages/alberta` workspace package (`editable = true` in `uv.sources`).
- **numpy<2:** Pinned for Brax/MuJoCo/JAX ABI compatibility. Do not widen until upstream wheels support numpy 2.x.
- **Do not commit:** `checkpoints/`, `*.mp4/gif/webm`, `calibration_data/`, `trajectories.db`, `data/raw/`, `out/`, `wandb/`, `*.usd`, large `*.npz` files. CI gate at `scripts/check-no-large-binaries.sh` fails any tracked file over 5 MB outside known-source asset dirs.
- **TS surface is thin:** The heavy logic lives in the Python sidecar (`eliza_robot`). The `src/` directory only re-exports constants and type aliases consumed by `@elizaos/plugin-ainex`.
- **ASIMOV-1:** See `docs/asimov-1.md` for the CAD edit loop, generated MuJoCo assets, text-conditioned training, bridge targets, and validation gates.

See the root `AGENTS.md` for repo-wide architecture commandments, logger-only rule, ESM conventions, and git workflow.
