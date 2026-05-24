# Alberta vs PPO Robot Backend Comparison

Profile: `hiwonder-ainex`
Tasks: `stand_up, walk_forward, turn_left, turn_right`
Requested steps: `4000`
Evaluation episodes/task: `4`
Max eval steps/episode: `120`
Domain randomization: `True`

| backend | regime | checkpoint valid | mean reward | delta vs untrained | output dim |
|---|---|---:|---:|---:|---:|
| Alberta | `alberta_streaming` | True | 409.1933 | -0.0620 | 24 |
| PPO | `smoke_sb3_ppo` | n/a | 409.2549 | -0.0005 | 24 |

## Per-Task Reward

| task | untrained | Alberta | Alberta delta | PPO | PPO delta | Alberta vs PPO |
|---|---:|---:|---:|---:|---:|---:|
| `stand_up` | 419.6724 | 419.6029 | -0.0696 | 419.6720 | -0.0004 | -0.0692 |
| `walk_forward` | 418.7756 | 418.7061 | -0.0696 | 418.7752 | -0.0004 | -0.0691 |
| `turn_left` | 399.1251 | 399.0555 | -0.0695 | 399.1246 | -0.0005 | -0.0690 |
| `turn_right` | 399.4481 | 399.4088 | -0.0394 | 399.4476 | -0.0005 | -0.0388 |

## Interpretation

This artifact proves both backends can train, checkpoint, load, and evaluate through the same profile-driven robot environment and text-conditioned policy wrapper. Small local step budgets are plumbing smoke evidence; production learning claims require the Nebius full-training artifacts.

Winner by mean reward in this run: `ppo`.
