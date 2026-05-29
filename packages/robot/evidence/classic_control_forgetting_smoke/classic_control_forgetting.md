# Classic-control catastrophic-forgetting benchmark

Training order: `CartPole-v1` then `Acrobot-v1`.

Steps: first task `200`, second task `200`; eval episodes `2`; seeds `1`.

PPO, DQN, and A2C are used as strong standard Stable-Baselines3 baselines for classic-control comparison. This is a reproducible local SOTA-style baseline set, not a claim about the absolute CartPole leaderboard.

| learner | CartPole after CartPole | CartPole after second task | retention delta | second-task final | forgetting | BWT |
|---|---:|---:|---:|---:|---:|---:|
| `alberta` | 10.00 +/- 0.00 | 10.00 +/- 0.00 | 0.00 +/- 0.00 | -500.00 +/- 0.00 | 0.00 +/- 0.00 | 0.00 +/- 0.00 |
| `ppo` | 13.50 +/- 0.00 | 12.50 +/- 0.00 | -1.00 +/- 0.00 | -500.00 +/- 0.00 | 1.00 +/- 0.00 | -1.00 +/- 0.00 |
| `dqn` | 10.00 +/- 0.00 | 10.00 +/- 0.00 | 0.00 +/- 0.00 | -500.00 +/- 0.00 | 0.00 +/- 0.00 | 0.00 +/- 0.00 |
| `a2c` | 10.00 +/- 0.00 | 10.00 +/- 0.00 | 0.00 +/- 0.00 | -500.00 +/- 0.00 | 0.00 +/- 0.00 | 0.00 +/- 0.00 |

- Retention delta is CartPole final return after the second task minus CartPole return immediately after CartPole training.
- Negative BWT and positive forgetting indicate catastrophic forgetting on the earlier task.
