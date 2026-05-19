# AGENTS.md — Eliza robotics stack

This file is the canonical contract for everything under `packages/robot/`.
It hosts the Python robotics stack (MuJoCo sim, Brax-PPO RL, websocket
bridge, perception, trajectory DB) and a thin TS surface consumed by
`@elizaos/plugin-ainex`.

---

## 1. What this package owns

- MuJoCo + MJX simulation environments and rollout harnesses.
- Brax-PPO RL training (skill-conditioned and text-conditioned).
- Websocket bridge between the runtime and physical/simulated robots.
- Perception adapters (camera, ASR, embeddings, ONNX inference).
- Trajectory database (SQLite-backed) for demos, replays, datasets.
- Pydantic schemas shared with the TS surface in `src/`.
- Multi-robot profiles. First profile: Hiwonder AiNex.

This package does NOT own:

- The Eliza plugin surface — that is `plugins/plugin-ainex/`.
- Vision pipeline orchestration — that is `plugins/plugin-vision/` (with
  this package providing the robot camera source adapter).
- Voice — `packages/inference/` and the voice pipeline live elsewhere.

---

## 2. Compute discipline

Heavy GPU work does NOT run on local dev boxes.

- Training, large rollouts, JIT-heavy compiles → Nebius (or another
  provisioned GPU host). The local box compiles, smoke-tests, and ships
  configs.
- Local commands MUST default to CPU JAX: `JAX_PLATFORMS=cpu`. Scripts
  that need GPU MUST fail loud when the runtime is misconfigured, not
  silently fall back.
- MJX compile time is non-trivial; cache `XLA_FLAGS` / JAX persistent
  cache to a known path under `~/.cache/eliza-robot/` and document the
  knob in the script's `--help`.

---

## 3. Profiles are first-class

Every codepath that touches a robot accepts a `RobotProfileId` and resolves
its URDF, calibration, gait, bridge transport, and safety envelope from
`profiles/<id>/`. No hardcoded `if robot == "ainex"` branches.

- Profile manifests live in `profiles/<id>/profile.yaml` (schema lands in
  W1.4).
- Heavy binary assets (URDF, STL, MJCF XML) live under
  `assets/profiles/<id>/` so the profile manifest stays small and
  reviewable.
- The first shipping profile is `hiwonder-ainex`. Adding a new robot is
  adding a profile, not patching the stack.

---

## 4. What never gets committed

- `checkpoints/` — RL training output. Lives on Nebius / object storage.
- Videos: `*.mp4`, `*.gif`, `*.webm` and `videos/`.
- `calibration_data/`, `trajectories.db` — captured per-machine.
- `data/raw/`, `data/processed/`, `out/`, `wandb/`, `results/`,
  `reports/*.html` — generated artifacts.
- `*.usd` scene exports, `generated/` code, large `*.npz` arrays.
- Python build artifacts: `__pycache__/`, `*.egg-info`, `.pytest_cache`,
  `.ruff_cache`, `.venv`, `*.so`.

The `.gitignore` covers the common cases. Size cannot be enforced via
gitignore — the CI gate at `scripts/check-no-large-binaries.sh` fails any
tracked file over 5 MB outside the known-source asset directories
(URDF / STL / MJCF XML under `assets/`).

---

## 5. Scope discipline

- Do not duplicate logic that already exists in `packages/training/` or
  `packages/inference/`. Reuse the optimizer (APOLLO), the publish flow,
  and the manifest schema where applicable.
- Do not invent a parallel websocket protocol when an existing schema in
  `schema/` covers the case. Extend the schema.
- Do not catch-and-continue on calibration or safety failures. Robots
  break things and people when guarded by silent fallbacks; failures must
  be loud.

---

## 6. Files to read before making changes

- `packages/robot/README.md` — directory map + entry points.
- `packages/robot/docs/SSD_PORT_ASSESSMENT.md` — port-from-SSD plan (lands
  in W1.1).
- `packages/training/AGENTS.md` — APOLLO mandate, no defensive code rule.
- Repo-wide `AGENTS.md` and `CLAUDE.md` — clean-architecture commandments
  and git workflow.
