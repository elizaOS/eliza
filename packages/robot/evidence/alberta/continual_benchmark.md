# Continual learning: Alberta vs PPO

Environment: `joint_reach`.

Sequential training on 5 task(s) sharing one observation/action space, 20000 env-steps/task, 2 seed(s). After every phase both learners are evaluated on **all** tasks; metrics are computed from the resulting task×phase matrix (Lopez-Paz & Ranzato 2017).

Learners: `alberta, ppo`.

| metric | Alberta | PPO | better |
|--------|---------|-----|--------|
| ACC ↑ | 35.03 ± 5.42 | 34.66 ± 0.39 | **Alberta** |
| BWT ↑ (0 = no forgetting) | -3.86 ± 3.86 | -6.98 ± 1.46 | **Alberta** |
| FORGETTING ↓ | 3.86 ± 3.86 | 9.26 ± 1.52 | **Alberta** |
| FWT ↑ | -0.87 ± 0.87 | -0.46 ± 0.06 | **PPO** |

## New-task adaptation and old-task retention

| learner | mean new-task gain | positive-gain tasks | task-0 retention delta | mean final-minus-best |
|---|---:|---:|---:|---:|
| `alberta` | 26.42 | 5.0/5.0 | -15.44 | -3.09 |
| `ppo` | 28.65 | 5.0/5.0 | -6.96 | -7.41 |

- **ACC** — final average performance across all tasks.
- **BWT** — backward transfer; negative ⇒ catastrophic forgetting.
- **Forgetting** — mean drop from each task's best-ever to its final score.
- **FWT** — forward transfer.

Alberta resists forgetting via streaming, ObGD-bounded, every-step updates over a sparse, task-localized representation (disjoint weight blocks per task). PPO's dense replay-based updates overwrite earlier skills as new tasks are learned.
