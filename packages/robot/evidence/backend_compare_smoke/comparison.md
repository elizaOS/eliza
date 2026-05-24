# Alberta vs PPO Robot Backend Comparison

Profile: `hiwonder-ainex`
Tasks: `stand_up, walk_forward`
Requested steps: `64`
Evaluation episodes/task: `1`
Max eval steps/episode: `20`
Domain randomization: `False`

| backend | regime | checkpoint valid | mean reward | delta vs untrained | output dim |
|---|---|---:|---:|---:|---:|
| Alberta | `alberta_streaming` | True | -6.7679 | -0.0002 | 24 |
| PPO | `smoke_sb3_ppo` | n/a | -6.7677 | -0.0000 | 24 |

## Per-Task Reward

| task | untrained | Alberta | Alberta delta | PPO | PPO delta | Alberta vs PPO |
|---|---:|---:|---:|---:|---:|---:|
| `stand_up` | -6.7644 | -6.7646 | -0.0002 | -6.7644 | -0.0000 | -0.0002 |
| `walk_forward` | -6.7710 | -6.7712 | -0.0002 | -6.7710 | -0.0000 | -0.0002 |

## Interpretation

This artifact proves both backends can train, checkpoint, load, and evaluate through the same profile-driven robot environment and text-conditioned policy wrapper. Small local step budgets are plumbing smoke evidence; production learning claims require the Nebius full-training artifacts.

Winner by mean reward in this run: `ppo`.
