# Alberta vs PPO Robot Backend Comparison

Profile: `hiwonder-ainex`
Tasks: `stand_up, walk_forward, turn_left, turn_right`
Requested steps: `4000`
Evaluation episodes/task: `4`
Max eval steps/episode: `120`
Domain randomization: `True`

| backend | regime | checkpoint valid | mean reward | delta vs untrained | output dim |
|---|---|---:|---:|---:|---:|
| Alberta | `alberta_streaming` | True | -6.8372 | -0.0001 | 24 |
| PPO | `smoke_sb3_ppo` | n/a | -6.8374 | -0.0003 | 24 |

## Per-Task Reward

| task | untrained | Alberta | Alberta delta | PPO | PPO delta | Alberta vs PPO |
|---|---:|---:|---:|---:|---:|---:|
| `stand_up` | -6.7644 | -6.7645 | -0.0001 | -6.7648 | -0.0004 | 0.0002 |
| `walk_forward` | -6.7710 | -6.7711 | -0.0001 | -6.7712 | -0.0002 | 0.0001 |
| `turn_left` | -6.9791 | -6.9792 | -0.0001 | -6.9795 | -0.0004 | 0.0002 |
| `turn_right` | -6.8340 | -6.8341 | -0.0001 | -6.8342 | -0.0002 | 0.0001 |

## Interpretation

This artifact proves both backends can train, checkpoint, load, and evaluate through the same profile-driven robot environment and text-conditioned policy wrapper. Small local step budgets are plumbing smoke evidence; production learning claims require the Nebius full-training artifacts.

Winner by mean reward in this run: `alberta`.
