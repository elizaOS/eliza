# Continual learning: Alberta vs PPO

Environment: `joint_reach`.

Sequential training on 4 task(s) sharing one observation/action space, 16000 env-steps/task, 3 seed(s). After every phase both learners are evaluated on **all** tasks; metrics are computed from the resulting task×phase matrix (Lopez-Paz & Ranzato 2017).

Learners: `alberta, ppo`.

| metric | Alberta | PPO | better |
|--------|---------|-----|--------|
| ACC ↑ | 38.30 ± 0.35 | 34.40 ± 0.95 | **Alberta** |
| BWT ↑ (0 = no forgetting) | 0.00 ± 0.00 | -9.29 ± 0.52 | **Alberta** |
| FORGETTING ↓ | 0.00 ± 0.00 | 10.04 ± 0.61 | **Alberta** |
| FWT ↑ | 0.00 ± 0.00 | -0.88 ± 0.74 | **Alberta** |

## New-task adaptation and old-task retention

| learner | mean new-task gain | positive-gain tasks | task-0 retention delta | mean final-minus-best |
|---|---:|---:|---:|---:|
| `alberta` | 25.58 | 4.0/4.0 | 0.00 | 0.00 |
| `ppo` | 28.61 | 4.0/4.0 | -13.60 | -7.53 |

- **ACC** — final average performance across all tasks.
- **BWT** — backward transfer; negative ⇒ catastrophic forgetting.
- **Forgetting** — mean drop from each task's best-ever to its final score.
- **FWT** — forward transfer.

Alberta resists forgetting via streaming, ObGD-bounded, every-step updates over a sparse, task-localized representation (disjoint weight blocks per task). PPO's dense replay-based updates overwrite earlier skills as new tasks are learned.
