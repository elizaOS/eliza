# Continual learning: Alberta vs PPO

Environment: `joint_reach`.

Sequential training on 4 task(s) sharing one observation/action space, 6000 env-steps/task, 2 seed(s). After every phase both learners are evaluated on **all** tasks; metrics are computed from the resulting task×phase matrix (Lopez-Paz & Ranzato 2017).

Learners: `alberta_cbp, ppo`.

| metric | Alberta | PPO | better |
|--------|---------|-----|--------|
| ACC ↑ | 35.71 ± 3.06 | 28.48 ± 0.72 | **Alberta** |
| BWT ↑ (0 = no forgetting) | 0.00 ± 0.00 | -1.59 ± 1.79 | **Alberta** |
| FORGETTING ↓ | 0.00 ± 0.00 | 3.74 ± 1.83 | **Alberta** |
| FWT ↑ | 0.00 ± 0.00 | -1.61 ± 0.42 | **Alberta** |

## New-task adaptation and old-task retention

| learner | mean new-task gain | positive-gain tasks | task-0 retention delta | mean final-minus-best |
|---|---:|---:|---:|---:|
| `alberta_cbp` | 18.52 | 3.0/4.0 | 0.00 | -1.16 |
| `ppo` | 12.38 | 4.0/4.0 | -4.55 | -2.80 |

- **ACC** — final average performance across all tasks.
- **BWT** — backward transfer; negative ⇒ catastrophic forgetting.
- **Forgetting** — mean drop from each task's best-ever to its final score.
- **FWT** — forward transfer.

Alberta resists forgetting via streaming, ObGD-bounded, every-step updates over a sparse, task-localized representation (disjoint weight blocks per task). PPO's dense replay-based updates overwrite earlier skills as new tasks are learned.
