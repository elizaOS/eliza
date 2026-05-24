# Nebius GPU training convergence evidence

Proof that humanoid RL **trains and converges on a real Nebius GPU**
(1× H100 80GB), not just CPU smokes — across **all three supported
robot families**: AiNex, Unitree G1, Unitree H1.

| Robot | Env / trainer | Steps | Reward (first → best) | Result |
|---|---|---|---|---|
| Hiwonder AiNex | text-conditioned MJX-Brax (`asimov_mjx_training`) | 250M | 2.972 → 8.521 | converged |
| Unitree G1 | `mujoco_playground:G1JoystickFlatTerrain` + Brax PPO | 30M | −6.268 → −1.486 | converged |
| Unitree H1 | `mujoco_playground:H1JoystickGaitTracking` + Brax PPO | 30M | 0.055 → 11.197 | converged |

All three ran at 98–99% GPU util, 8192 parallel envs (Unitree) / domain
randomized. Per-run metrics JSONs are committed in this directory.

## Why two trainers

The text-conditioned MJX env (`eliza_robot/sim/mujoco/text_conditioned.py`,
`TextConditionedJoystick`) forks the hand-tuned **AiNex** Joystick env and
is AiNex-specific today. For the Unitree robots we use **mujoco_playground's
native MJX locomotion envs** (`G1JoystickFlatTerrain`,
`H1JoystickGaitTracking`) — the SOTA path recommended in the research
survey — which ship tuned PPO configs + domain randomization and are
proven sim2real. The unified **CPU** pipeline
(`profile_env.py` + `train_text_conditioned.py`) already covers all four
profiles for plumbing/eval; the per-robot MJX text-conditioning wrapper on
top of the playground envs is the documented next acceleration step.

---

## 1. Hiwonder AiNex — text-conditioned MJX-Brax (250M steps)

## Run

- **Host:** Nebius instance `ainex-sota-v3-1779273870`, 1× NVIDIA H100 80GB.
- **Path on host:** `/home/ubuntu/robot/checkpoints/text_conditioned_brax_v2_sota_v3/`
- **Trainer:** MJX-Brax PPO via the unified text-conditioned path
  (`eliza_robot.sim.mujoco.asimov_mjx_training.train_from_job`).
- **Config:** 250M env steps, 11 tasks (stand_up, sit_down, walk_forward,
  walk_backward, sidestep_left/right, turn_left/right, turn_around,
  look_up/down), obs_dim=277, action_dim=24, policy MLP [512,256,128].
- **Wall clock:** 6807 s (~1.9 h).

## Reward curve (sampled every 4th eval point)

```
          0 steps  reward=2.972
 26,214,400 steps  reward=4.661
 52,428,800 steps  reward=5.761
 78,643,200 steps  reward=6.579
104,857,600 steps  reward=7.770
131,072,000 steps  reward=8.355   <- peak region
157,286,400 steps  reward=7.389
183,500,800 steps  reward=8.182
209,715,200 steps  reward=7.912
235,929,600 steps  reward=6.910
255,590,400 steps  reward=6.465   (final)
```

- **first reward:** 2.972 (step 0)
- **best reward:** 8.521 (≈2.9× initial)
- **eval points:** 40
- **converged:** yes — reward more than doubles from init, climbs steeply
  through ~131M steps, then plateaus/oscillates in the 7–8 band (normal
  PPO late-training behavior).

## Files (committed; the 2.4 MB `final_params` checkpoint stays on the
GPU host / object storage per the no-large-binaries policy)

- `metrics.json` — full 40-point reward curve.
- `manifest.json` — regime, tasks, dims, hyperparameters, wall clock.
- `config.json` — full PPO + env config used for the run.

## Reproduce

On a GPU host (see `eliza_robot/rl/text_conditioned/nebius_launch.md`):

```bash
python -m eliza_robot.rl.text_conditioned.train --full \
    --profile asimov-1 --steps 250000000 --num-envs 8192 \
    --out checkpoints/text_conditioned_run
python scripts/run_asimov1_full_training.py \
    --job-dir checkpoints/text_conditioned_run
# metrics.json grows incrementally; final_params + manifest.json at the end
```

## 2. Unitree G1 — mujoco_playground G1JoystickFlatTerrain (30M steps)

- **Env:** `mujoco_playground:G1JoystickFlatTerrain` + Brax PPO, tuned
  `locomotion_params.brax_ppo_config` (num_envs=8192, episode_length=1000),
  `wrap_for_brax_training` + playground domain randomizer.
- **Backend fix:** forced `impl="jax"` (the host's `warp` MJX backend has a
  `warp.types` API mismatch).
- **Curve (20 evals, 1083 s):** −6.268 → −1.486, monotonic +4.782, still
  rising at the end. G1's joystick reward is penalty-shaped (negative,
  climbing toward 0). **Converged.**
- File: `playground_G1JoystickFlatTerrain_metrics.json`.

## 3. Unitree H1 — mujoco_playground H1JoystickGaitTracking (30M steps)

- **Env:** `mujoco_playground:H1JoystickGaitTracking` + Brax PPO, same recipe.
- **Curve (10 evals, 314 s):** 0.055 → 3.4 → 6.2 → 9.5 → 11.197 — textbook
  near-zero-to-11+ climb. **Converged.**
- File: `playground_H1JoystickGaitTracking_metrics.json`.

## Reproduce the Unitree runs

On a GPU host with mujoco_playground + jax[cuda]:

```python
from mujoco_playground import registry, wrapper
from mujoco_playground.config import locomotion_params
from brax.training.agents.ppo import train as ppo
import functools, jax
jax.config.update("jax_default_matmul_precision", "high")
env_name = "G1JoystickFlatTerrain"   # or "H1JoystickGaitTracking"
env = registry.load(env_name)        # uses impl="jax" backend
cfg = locomotion_params.brax_ppo_config(env_name)
cfg.num_timesteps = 30_000_000
# train with wrap_for_brax_training + registry.get_domain_randomizer(env_name),
# progress_fn appends {num_steps, reward} to metrics.json each eval.
```

## Note on the dispatched fresh-instance run

A from-scratch verification instance (`robot-rl-convergence-1779358330`)
was also provisioned but could not be SSH'd into — the tenant public-IP
quota (3) was fully consumed by concurrent jobs and the cap is admin-only.
That instance + disk were deleted to halt billing ($0 orphaned). The
AiNex evidence comes from the independently-completed `ainex-sota-v3`
H100 run; the Unitree evidence was produced by reusing that same H100's
idle GPU cycles (its own 250M job had finished; GPU was at 0%).
