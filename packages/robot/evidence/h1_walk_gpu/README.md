# Proven bipedal walking — Unitree H1 (off-the-shelf MuJoCo Playground + Brax PPO)

Date: 2026-05-28. Hardware: local NVIDIA RTX 5080 Laptop GPU (16 GB), CUDA 13.2
driver, JAX cuda12 plugin. Trained in ~12 min (vs ~2.5 h on CPU).

## What this is

A genuine bipedal **walking** policy for `mujoco_playground:H1JoystickGaitTracking`,
trained with Brax PPO (8192 envs, 100M steps) via
`scripts/train_playground_locomotion.py`, then evaluated by the honest gate in
`eliza_robot/rl/locomotion_metrics.py`.

`walk_eval.json` (command = forward 1.0 m/s, 400 steps / 8 s, seed 1):

| metric | value |
|---|---|
| `walk_forward_pass` | **true** |
| forward displacement | 3.75 m |
| lateral drift | 0.29 m (straight) |
| mean forward velocity | 0.47 m/s |
| max foot height (L/R) | 0.30 / 0.32 m (feet clearly leave the ground) |
| alternating foot contacts | 21 |
| min base height | 0.95 m (upright) |
| fell | **false** (full 8 s) |

`walk_contact_sheet.jpg` — 8 evenly-spaced frames (track camera) showing the
upright H1 mid-stride with an alternating swing/stance gait. The full
`walk_forward.mp4` is produced locally but git-ignored (no-video policy).

## The trap this exposed (why the honest gate matters)

- **Reward ≠ walking.** The default recipe reached reward 80 and an anti-skate
  variant reward 77 — both look "converged" — yet whether they *walk* can only
  be judged by foot kinematics, not reward.
- **`feet_air_time` / `last_contact` are unreliable in this env**: the contact
  flag stays `[1,1]` and air-time `[0,0]` even when the foot site rises ~0.3 m.
  An early gate built on that flag produced a FALSE "skating" negative on a
  policy that was actually stepping. The gate/eval now derive stance/swing from
  foot-site HEIGHT (`< 0.06 m` = stance), which matches the real kinematics.

## Reproduce

```bash
# train (GPU)
ELIZA_ROBOT_USE_GPU=1 uv run python scripts/train_playground_locomotion.py \
  --env H1JoystickGaitTracking --num-timesteps 100000000 --num-envs 8192 \
  --num-evals 40 --out checkpoints/h1_walk
# evaluate + render (CPU is fine; honest gate)
MUJOCO_GL=egl uv run python scripts/train_playground_locomotion.py \
  --env H1JoystickGaitTracking --eval-only --out checkpoints/h1_walk \
  --command 1.0 0.0 0.0 --eval-steps 400 --seed 1 --render
```
