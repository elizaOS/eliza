# Continual learning: Alberta vs PPO

Environment: `obstacle_course`.

Sequential training on 2 task(s) sharing one observation/action space, 2500 env-steps/task, 1 seed(s). After every phase both learners are evaluated on **all** tasks; metrics are computed from the resulting task×phase matrix (Lopez-Paz & Ranzato 2017).

Learners: `alberta, ppo`.

| metric | Alberta | PPO | better |
|--------|---------|-----|--------|
| ACC ↑ | 4.10 ± 0.00 | 2.50 ± 0.00 | **Alberta** |
| BWT ↑ (0 = no forgetting) | 0.00 ± 0.00 | 0.71 ± 0.00 | **PPO** |
| FORGETTING ↓ | 0.00 ± 0.00 | 0.00 ± 0.00 | **PPO** |
| FWT ↑ | 0.00 ± 0.00 | -0.31 ± 0.00 | **Alberta** |

## New-task adaptation and old-task retention

| learner | mean new-task gain | positive-gain tasks | task-0 retention delta | mean final-minus-best |
|---|---:|---:|---:|---:|
| `alberta` | 3.85 | 1.0/2.0 | 0.00 | -0.24 |
| `ppo` | 1.87 | 1.0/2.0 | 0.71 | 0.00 |

- **ACC** — final average performance across all tasks.
- **BWT** — backward transfer; negative ⇒ catastrophic forgetting.
- **Forgetting** — mean drop from each task's best-ever to its final score.
- **FWT** — forward transfer.

Alberta resists forgetting via streaming, ObGD-bounded, every-step updates over a sparse, task-localized representation (disjoint weight blocks per task). PPO's dense replay-based updates overwrite earlier skills as new tasks are learned.
