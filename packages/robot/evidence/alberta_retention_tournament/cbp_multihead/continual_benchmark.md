# Continual learning: Alberta vs PPO

Environment: `joint_reach`.

Sequential training on 4 task(s) sharing one observation/action space, 6000 env-steps/task, 2 seed(s). After every phase both learners are evaluated on **all** tasks; metrics are computed from the resulting task×phase matrix (Lopez-Paz & Ranzato 2017).

Learners: `alberta_cbp, ppo`.

| metric | Alberta | PPO | better |
|--------|---------|-----|--------|
| ACC ↑ | 38.94 ± 2.32 | 28.48 ± 0.72 | **Alberta** |
| BWT ↑ (0 = no forgetting) | -4.56 ± 3.51 | -1.59 ± 1.79 | **PPO** |
| FORGETTING ↓ | 5.67 ± 2.59 | 3.74 ± 1.83 | **PPO** |
| FWT ↑ | 0.00 ± 0.00 | -1.61 ± 0.42 | **Alberta** |

## New-task adaptation and old-task retention

| learner | mean new-task gain | positive-gain tasks | task-0 retention delta | mean final-minus-best |
|---|---:|---:|---:|---:|
| `alberta_cbp` | 25.16 | 3.5/4.0 | -10.31 | -4.26 |
| `ppo` | 12.38 | 4.0/4.0 | -4.55 | -2.80 |

- **ACC** — final average performance across all tasks.
- **BWT** — backward transfer; negative ⇒ catastrophic forgetting.
- **Forgetting** — mean drop from each task's best-ever to its final score.
- **FWT** — forward transfer.

Alberta resists forgetting via streaming, ObGD-bounded, every-step updates over a sparse, task-localized representation (disjoint weight blocks per task). PPO's dense replay-based updates overwrite earlier skills as new tasks are learned.
