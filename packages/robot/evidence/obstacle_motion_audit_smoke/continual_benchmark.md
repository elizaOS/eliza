# Continual learning: Alberta vs PPO

Environment: `obstacle_course`.

Sequential training on 3 task(s) sharing one observation/action space, 500 env-steps/task, 1 seed(s). After every phase both learners are evaluated on **all** tasks; metrics are computed from the resulting task×phase matrix (Lopez-Paz & Ranzato 2017).

Learners: `alberta, ppo`.

| metric | Alberta | PPO | better |
|--------|---------|-----|--------|
| ACC ↑ | 7.26 ± 0.00 | 1.72 ± 0.00 | **Alberta** |
| BWT ↑ (0 = no forgetting) | 0.00 ± 0.00 | 0.09 ± 0.00 | **PPO** |
| FORGETTING ↓ | 0.00 ± 0.00 | 0.13 ± 0.00 | **Alberta** |
| FWT ↑ | 0.00 ± 0.00 | 0.20 ± 0.00 | **PPO** |

## New-task adaptation and old-task retention

| learner | mean new-task gain | positive-gain tasks | task-0 retention delta | mean final-minus-best |
|---|---:|---:|---:|---:|
| `alberta` | 6.90 | 3.0/3.0 | 0.00 | 0.00 |
| `ppo` | 1.28 | 3.0/3.0 | -0.26 | -0.09 |

## Physical obstacle-course rollout checks

| learner | final success rate | final collision rate | final passed-obstacle rate | final forward progress m | min obstacle clearance m |
|---|---:|---:|---:|---:|---:|
| `alberta` | 0.89 | 0.11 | 0.89 | 2.12 | -0.00 |
| `ppo` | 0.00 | 0.00 | 0.00 | 0.71 | 0.04 |

- **ACC** — final average performance across all tasks.
- **BWT** — backward transfer; negative ⇒ catastrophic forgetting.
- **Forgetting** — mean drop from each task's best-ever to its final score.
- **FWT** — forward transfer.

Alberta resists forgetting via streaming, ObGD-bounded, every-step updates over a sparse, task-localized representation (disjoint weight blocks per task). PPO's dense replay-based updates overwrite earlier skills as new tasks are learned.
