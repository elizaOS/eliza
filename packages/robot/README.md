# @elizaos/robot

Python robotics stack (MuJoCo sim, Brax-PPO RL, websocket bridge, perception,
trajectory DB) plus a thin TypeScript surface for re-exports and shared
schemas. Used by `@elizaos/plugin-ainex` to drive simulated and real robots.

Multi-robot support is profile-driven. Every URDF/asset bundle, calibration,
gait, and bridge configuration is keyed by `RobotProfileId` and lives under
`profiles/<id>/` (with binary assets under `assets/profiles/<id>/`). The first
shipping profile is **Hiwonder AiNex** at `profiles/hiwonder-ainex/`.

## Directory map

```
src/                 TS surface (re-exports, shared schemas)
sim/                 MuJoCo sim entrypoints
  mujoco/            MJX scenes, env wrappers
bridge/              Websocket bridge (robot ↔ runtime)
  backends/          Per-robot serial/USB/CAN backends
rl/                  Brax-PPO trainers and rollout harnesses
  skills/            Skill-conditioned policies
  text_conditioned/  Text-conditioned multi-task RL
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

## Commands

```bash
bun run robot:bridge:mock     # bridge against the mock backend
bun run robot:bridge:mujoco   # bridge against the MuJoCo simulator
bun run robot:demo            # voice + sim demo (examples/robot-mujoco-demo)
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
