# Alberta vs PPO Robot Backend Comparison

Profile: `asimov-1`
Tasks: `stand_up, walk_forward, walk_backward, sidestep_left, sidestep_right, turn_left, turn_right`
Requested steps: `30000`
Evaluation episodes/task: `5`
Max eval steps/episode: `200`
Domain randomization: `True`

| backend | regime | checkpoint valid | mean reward | delta vs untrained | output dim |
|---|---|---:|---:|---:|---:|
| Alberta | `alberta_streaming` | True | 165.8210 | -85.6840 | 25 |
| PPO | `smoke_sb3_ppo` | n/a | 194.8435 | -56.6615 | 25 |

## Per-Task Reward

| task | untrained | Alberta | Alberta delta | PPO | PPO delta | Alberta vs PPO |
|---|---:|---:|---:|---:|---:|---:|
| `stand_up` | 255.5190 | 170.1360 | -85.3831 | 200.1430 | -55.3761 | -30.0070 |
| `walk_forward` | 253.9385 | 161.9756 | -91.9629 | 193.3491 | -60.5895 | -31.3735 |
| `walk_backward` | 256.4093 | 169.5055 | -86.9038 | 195.6654 | -60.7438 | -26.1600 |
| `sidestep_left` | 255.3307 | 161.4537 | -93.8771 | 194.3899 | -60.9408 | -32.9362 |
| `sidestep_right` | 255.3295 | 169.9479 | -85.3816 | 193.8164 | -61.5132 | -23.8685 |
| `turn_left` | 241.9891 | 159.9565 | -82.0326 | 191.0726 | -50.9165 | -31.1161 |
| `turn_right` | 242.0188 | 167.7718 | -74.2470 | 195.4685 | -46.5503 | -27.6967 |

## Interpretation

This artifact proves both backends can train, checkpoint, load, and evaluate through the same profile-driven robot environment and text-conditioned policy wrapper. Small local step budgets are plumbing smoke evidence; production learning claims require the Nebius full-training artifacts.

Winner by mean reward in this run: `ppo`.
