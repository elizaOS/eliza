# Alberta vs PPO Robot Backend Comparison

Profile: `asimov-1`
Tasks: `stand_up, walk_forward, turn_left, turn_right`
Requested steps: `4000`
Evaluation episodes/task: `4`
Max eval steps/episode: `120`
Domain randomization: `True`

| backend | regime | checkpoint valid | mean reward | delta vs untrained | output dim |
|---|---|---:|---:|---:|---:|
| Alberta | `alberta_streaming` | True | 159.9699 | -88.3965 | 25 |
| PPO | `smoke_sb3_ppo` | n/a | 247.4312 | -0.9351 | 25 |

## Per-Task Reward

| task | untrained | Alberta | Alberta delta | PPO | PPO delta | Alberta vs PPO |
|---|---:|---:|---:|---:|---:|---:|
| `stand_up` | 255.5190 | 169.7608 | -85.7582 | 253.5156 | -2.0034 | -83.7548 |
| `walk_forward` | 253.9385 | 165.6322 | -88.3063 | 252.4681 | -1.4705 | -86.8359 |
| `turn_left` | 241.9891 | 171.1780 | -70.8110 | 244.6579 | 2.6688 | -73.4798 |
| `turn_right` | 242.0188 | 133.3084 | -108.7104 | 239.0834 | -2.9354 | -105.7750 |

## Interpretation

This artifact proves both backends can train, checkpoint, load, and evaluate through the same profile-driven robot environment and text-conditioned policy wrapper. Small local step budgets are plumbing smoke evidence; production learning claims require the Nebius full-training artifacts.

Winner by mean reward in this run: `ppo`.
