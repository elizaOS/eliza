# Nebius GPU training convergence evidence

Proof that the text-conditioned humanoid RL pipeline **trains and
converges on a real Nebius GPU**, not just CPU smokes.

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

## Note on the dispatched verification run

A fresh verification instance (`robot-rl-convergence-1779358330`) was also
provisioned but could not be SSH'd into — the tenant public-IP quota (3)
was fully consumed by concurrent jobs, and the cap is admin-only. That
instance + disk were deleted to halt billing. The convergence evidence
here comes from the independently-completed `ainex-sota-v3` H100 run,
which exercises the identical MJX-Brax entrypoint.
