# Unified multi-robot text-conditioned RL

Single pipeline that trains, evaluates, and serves a text-conditioned
locomotion policy across four humanoids:

| Profile id | DoF | Source |
|---|---|---|
| `hiwonder-ainex` | 24 | educational Hiwonder humanoid |
| `asimov-1` | 25 | Menlo Asimov-1 open hardware humanoid |
| `unitree-g1` | 29 | mujoco_menagerie/unitree_g1 |
| `unitree-h1` | 19 | mujoco_menagerie/unitree_h1 |

## Architecture

```
                   profile.yaml                                  +-- MJCF (mjcf_xml)
                       |                                         |
   curriculum/         v                                         v
   tasks.yaml --> TextConditionedProfileEnv ----------> MuJoCo (CPU) / MJX (GPU)
       |                ^                                         |
       v                |                                         v
   sentence-          policy.step --> joint targets        offscreen renderer
   transformer +                          |                  + libx264
   PCA encoder                            v                       |
                                    scripts/                      v
                                interactive_viewer.py        evidence/agent_videos/
                                    + bridge/server.py
                                          ^
                                          |
                            plugin-ainex AINEX_RUN_RL action
                                          ^
                                          |
                                    Eliza chat agent
```

## CLI cheatsheet

```bash
# Add a new Unitree profile (sparse-clones menagerie if needed)
./scripts/sync_menagerie.sh
uv run python scripts/generate_unitree_profile.py --robot g1
uv run python scripts/generate_unitree_profile.py --robot h1

# Train any profile with the default Alberta continual-learning backend
# --steps is a total budget split across selected tasks.
uv run python scripts/train_text_conditioned.py --profile unitree-g1 --steps 30000

# Optional PPO smoke baseline
uv run python scripts/train_text_conditioned.py --profile unitree-g1 --backend ppo --steps 30000

# Drop into an interactive viewer and type commands. By default this uses a
# profile-matching Alberta checkpoint when present; pass --policy-checkpoint
# to select a specific checkpoint.
uv run python scripts/interactive_viewer.py --profile unitree-g1
  >> walk forward
  >> turn left
  >> stand up

# Headless: scripted commands, mp4 per command, ego-pose recording
uv run python scripts/interactive_viewer.py \
    --profile unitree-g1 --headless \
    --commands "walk forward" "turn left" \
    --record evidence/agent_videos/unitree-g1 \
    --record-camera head_cam

# All robots × all commands, end-to-end (what Eliza would do)
uv run python scripts/record_agent_videos.py \
    --commands "stand up" "walk forward" "turn left" "turn right" \
    --max-steps 200
```

## Where things live

- `profiles/<id>/profile.yaml` — canonical per-robot manifest
  (kinematics, gait, sensors, cameras, control, assets, action library,
  safety, bridge_capabilities). One Pydantic `RobotProfile` per file.
- `assets/profiles/<id>/{mjcf,meshes,LICENSE}/` — binary URDF/STL/MJCF.
- `eliza_robot/rl/text_conditioned/profile_env.py` — single
  `TextConditionedProfileEnv` class; no AiNex-vs-Asimov fork.
- `scripts/train_text_conditioned.py` — single training entrypoint; Alberta is
  the default backend, PPO is an explicit smoke baseline.
- `scripts/interactive_viewer.py` — single viewer + mp4 recorder.
- `scripts/record_agent_videos.py` — end-to-end Eliza-style harness.
- `plugins/plugin-ainex/src/actions/runRl.ts` — `AINEX_RUN_RL` action;
  ships free-form text to bridge `policy.start { task }`.
- `eliza_robot/bridge/server.py:policy.start` — server-side handler.
- `vendor/mujoco_menagerie/` — gitignored sparse checkout (build-time
  only); the canonical copies live under `assets/profiles/<id>/mjcf/`.

## What still requires GPU (Nebius)

- Brax-MJX 100M+ step PPO baseline/full-training
  (`eliza_robot/sim/mujoco/asimov_mjx_training.py`).
- Reference: `checkpoints/text_conditioned_brax_v2_sota_250m/` reached
  best_reward = 30.81 over 11 tasks at 250M env steps in ~1.9 h.

Short Alberta runs through `scripts/train_text_conditioned.py` are the local
continual-learning plumbing check. Full production policies and long
comparative PPO/MJX runs come from Nebius.
