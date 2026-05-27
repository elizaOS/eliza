# Classic-control catastrophic-forgetting benchmark

Training order: `CartPole-v1` then `Acrobot-v1`.

Steps: first task `1000`, second task `1000`; eval episodes `5`; seeds `1`.

PPO, DQN, and A2C are used as strong standard Stable-Baselines3 baselines for classic-control comparison. This is a reproducible local SOTA-style baseline set, not a claim about the absolute CartPole leaderboard.

| learner | CartPole after CartPole | CartPole after second task | retention delta | second-task final | forgetting | BWT |
|---|---:|---:|---:|---:|---:|---:|
| `alberta` | 9.80 +/- 0.00 | 9.80 +/- 0.00 | 0.00 +/- 0.00 | -500.00 +/- 0.00 | 0.00 +/- 0.00 | 0.00 +/- 0.00 |
| `ppo` | 19.80 +/- 0.00 | 19.40 +/- 0.00 | -0.40 +/- 0.00 | -275.00 +/- 0.00 | 0.40 +/- 0.00 | -0.40 +/- 0.00 |
| `dqn` | 9.40 +/- 0.00 | 16.40 +/- 0.00 | 7.00 +/- 0.00 | -500.00 +/- 0.00 | 0.00 +/- 0.00 | 7.00 +/- 0.00 |
| `a2c` | 23.60 +/- 0.00 | 21.60 +/- 0.00 | -2.00 +/- 0.00 | -500.00 +/- 0.00 | 2.00 +/- 0.00 | -2.00 +/- 0.00 |

- Retention delta is CartPole final return after the second task minus CartPole return immediately after CartPole training.
- Negative BWT and positive forgetting indicate catastrophic forgetting on the earlier task.
