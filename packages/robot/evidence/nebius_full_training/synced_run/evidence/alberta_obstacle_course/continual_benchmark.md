# Continual learning: Alberta vs PPO

Environment: `obstacle_course`.

Sequential training on 4 task(s) sharing one observation/action space, 16000 env-steps/task, 3 seed(s). After every phase both learners are evaluated on **all** tasks; metrics are computed from the resulting task×phase matrix (Lopez-Paz & Ranzato 2017).

Learners: `alberta, ppo`.

| metric | Alberta | PPO | better |
|--------|---------|-----|--------|
| ACC ↑ | 2.11 ± 0.13 | 4.15 ± 0.53 | **PPO** |
| BWT ↑ (0 = no forgetting) | 0.00 ± 0.00 | -2.77 ± 1.87 | **Alberta** |
| FORGETTING ↓ | 0.00 ± 0.00 | 2.80 ± 1.83 | **Alberta** |
| FWT ↑ | 0.00 ± 0.00 | -0.04 ± 0.24 | **Alberta** |

## New-task adaptation and old-task retention

| learner | mean new-task gain | positive-gain tasks | task-0 retention delta | mean final-minus-best |
|---|---:|---:|---:|---:|
| `alberta` | 1.70 | 2.0/4.0 | 0.00 | -1.13 |
| `ppo` | 5.81 | 4.0/4.0 | -5.00 | -2.10 |

- **ACC** — final average performance across all tasks.
- **BWT** — backward transfer; negative ⇒ catastrophic forgetting.
- **Forgetting** — mean drop from each task's best-ever to its final score.
- **FWT** — forward transfer.

Alberta resists forgetting via streaming, ObGD-bounded, every-step updates over a sparse, task-localized representation (disjoint weight blocks per task). PPO's dense replay-based updates overwrite earlier skills as new tasks are learned.
