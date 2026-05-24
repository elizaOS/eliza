# @elizaos/robot

Python robotics stack (MuJoCo sim, Alberta continual-RL training, Brax/MJX
full-training support, websocket bridge, perception, trajectory DB) plus a thin
TypeScript surface for re-exports and shared schemas. Used by
`@elizaos/plugin-ainex` to drive simulated and real robots.

Multi-robot support is profile-driven. Every URDF/asset bundle, calibration,
gait, and bridge configuration is keyed by `RobotProfileId` and lives under
`profiles/<id>/` (with binary assets under `assets/profiles/<id>/`). The first
shipping profile is **Hiwonder AiNex** at `profiles/hiwonder-ainex/`.
Installed deployments can mount those directories separately and set
`ELIZA_ROBOT_PROFILES_ROOT` plus `ELIZA_ROBOT_ASSETS_ROOT`.

## Directory map

```
src/                 TS surface (re-exports, shared schemas)
sim/                 MuJoCo sim entrypoints
  mujoco/            MJX scenes, env wrappers
bridge/              Websocket bridge (robot ↔ runtime)
  backends/          Per-robot serial/USB/CAN backends
rl/                  Alberta continual-RL trainers, PPO baselines, rollout harnesses
  skills/            Skill-conditioned policies
  text_conditioned/  Text-conditioned multi-task RL
  alberta/           Alberta-Plan continual learning (learns a task sequence
                     without catastrophic forgetting; beats PPO on continual
                     RL — see rl/alberta/README.md)
perception/          Camera, ASR, embeddings, ONNX models
trajectory_db/       SQLite-backed trajectory store
schema/              Pydantic schemas shared with the TS surface
profiles/            Per-robot profile manifests
  hiwonder-ainex/    Hiwonder AiNex profile (default)
assets/              Binary assets (URDF/STL/XML)
  profiles/<id>/     Per-profile assets
scripts/             CLI helpers + CI gates
tests/               pytest suite
docs/                Architecture notes, SSD port assessment
checkpoints/         (gitignored) RL checkpoints
data/                (gitignored) datasets, captures, calibration
```

ASIMOV-1 integration details live in
[`docs/asimov-1.md`](./docs/asimov-1.md), covering the pinned upstream
submodule, generated MuJoCo assets, CAD edit loop, text-conditioned training,
bridge targets, and validation gates.
Alberta training readiness and validation evidence live in
[`docs/ALBERTA_PRODUCTION_READINESS.md`](./docs/ALBERTA_PRODUCTION_READINESS.md).

## Commands

```bash
bun run robot:bridge:mock     # bridge against the mock backend
bun run robot:bridge:mujoco   # bridge against the MuJoCo simulator
bun run robot:demo            # voice + sim demo (examples/robot-mujoco-demo)
uv run python scripts/train_text_conditioned.py --profile hiwonder-ainex --steps 30000
uv run eliza-robot-train --profile hiwonder-ainex --steps 30000
uv run python -m eliza_robot.bridge.server --backend mock --policy-checkpoint checkpoints/alberta_text_conditioned
uv run python -m eliza_robot.rl.alberta.benchmark --steps-per-task 16000 --seeds 3
uv run eliza-robot-benchmark-alberta --steps-per-task 16000 --seeds 3
bun run --cwd packages/robot build        # tsdown — TS surface
bun run --cwd packages/robot typecheck    # tsc --noEmit
bun run --cwd packages/robot test         # vitest + pytest shim
bun run --cwd packages/robot test:py      # uv run pytest tests/ -q
```

## Conventions

- Never run heavy GPU work locally — push to Nebius.
- Force CPU JAX locally: `JAX_PLATFORMS=cpu`.
- Do not commit checkpoints, videos, or large data. The `.gitignore` covers
  the common cases. `*.npz` files larger than ~5MB should be stored
  externally — gitignore cannot enforce size, so be explicit when adding
  fixtures.
- Profiles are first-class: every codepath that touches a robot accepts a
  `RobotProfileId` and resolves assets/config from `profiles/<id>/`.

See [`AGENTS.md`](./AGENTS.md) for the full contract.
