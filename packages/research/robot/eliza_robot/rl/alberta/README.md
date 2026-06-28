# Alberta-Plan continual learning for robot control

This package trains robot policies that **learn a sequence of tasks without
catastrophically forgetting** earlier ones — using the vendored
[Alberta framework](../../../../alberta) (`packages/alberta`), an implementation
of [The Alberta Plan for AI Research](https://arxiv.org/abs/2208.11173).

Standard deep-RL (PPO) trained on tasks one after another *overwrites* earlier
skills: the policy network's shared weights drift to fit the current task and
the old behaviour is lost. The robot literature calls this the dual problem of
**catastrophic forgetting** and **loss of plasticity**. The Alberta approach
attacks both with two design choices realised here:

1. **Streaming, bounded, every-step updates.** The controller updates at every
   timestep with no replay buffer and no epochs, and each update is bounded by
   ObGD (Elsayed et al. 2024) so a single transition cannot blow away learned
   weights — gentle drift instead of bulk overwrite.
2. **Sparse, task-localized representation.** A frozen feature lift gates the
   observation through a sparse code of its task-embedding channel: each task
   activates a *disjoint* block of features, so the linear policy weights for
   one task are never touched while another is being learned (French 1991;
   tile-coding heritage). PPO's dense MLP structurally cannot do this.

## Components

| File | Role |
|------|------|
| `agent.py` | `AlbertaContinualController` — streaming continuous-action actor-critic + ObGD bounding + feature lift. Numpy-friendly `start`/`observe`/`act_greedy`. |
| `features.py` | `FeatureMap` — `raw`, `random_tanh`, and `sparse_gated` (the continual-learning lift). |
| `loop.py` | `train_online` / `evaluate` — online act→update control loops for any `gymnasium.Env`. |
| `continual_env.py` | `JointReachEnv` — fast, deterministic, task-conditioned joint-servo env for the benchmark. |
| `metrics.py` | ACC / BWT / Forgetting / FWT over the task×phase performance matrix. |
| `baselines.py` | `AlbertaSequentialLearner`, `PPOSequentialLearner`, and optional `SACSequentialLearner` (SB3) behind one interface. |
| `benchmark.py` | The Alberta-vs-PPO continual-learning head-to-head, with optional SAC; writes JSON + plot. |
| `train_robot.py` | Trains the controller on the real MuJoCo `TextConditionedProfileEnv`; writes a `TextConditionedPolicy`-compatible checkpoint (`regime="alberta_streaming"`). |

## Run the benchmark

```bash
# fast head-to-head on the JointReach continual env (CPU)
JAX_PLATFORMS=cpu uv run python -m eliza_robot.rl.alberta.benchmark \
    --steps-per-task 16000 --seeds 3 --out-dir evidence/alberta
```

Outputs `evidence/alberta/continual_benchmark.{json,png}` with per-seed
performance matrices and mean ACC/BWT/Forgetting/FWT for both learners.

Add an off-policy SAC baseline when you want a broader Alberta-vs-standard-RL
comparison:

```bash
JAX_PLATFORMS=cpu uv run python -m eliza_robot.rl.alberta.benchmark \
    --learners alberta ppo sac \
    --steps-per-task 16000 --seeds 3 --out-dir evidence/alberta_sac
```

## Train a real robot policy with Alberta

```bash
JAX_PLATFORMS=cpu uv run python -m eliza_robot.rl.alberta.train_robot \
    --profile hiwonder-ainex --tasks stand_up walk_forward --steps-per-task 4000
```

Writes `checkpoints/alberta_text_conditioned/{alberta_policy.npz,manifest.json}`,
loadable by `eliza_robot.rl.text_conditioned.policy.TextConditionedPolicy` for
inference on the robot bridge.
