# Classic-control catastrophic-forgetting benchmark

Training order: `CartPole-v1` then `Acrobot-v1`.

Steps: first task `2000`, second task `2000`; eval episodes `5`; seeds `1`.

Alberta is run through the vendored discrete `SARSAAgent` with sparse-gated task-local features and task-valid action masking.

PPO, DQN, and A2C are used as strong standard Stable-Baselines3 baselines for classic-control comparison. This is a reproducible local SOTA-style baseline set, not a claim about the absolute CartPole leaderboard.

| learner | CartPole after CartPole | CartPole after second task | retention delta | second-task final | forgetting | BWT |
|---|---:|---:|---:|---:|---:|---:|
| `alberta` | 22.40 +/- 0.00 | 48.20 +/- 0.00 | 25.80 +/- 0.00 | -500.00 +/- 0.00 | 0.00 +/- 0.00 | 25.80 +/- 0.00 |
| `ppo` | 22.60 +/- 0.00 | 24.40 +/- 0.00 | 1.80 +/- 0.00 | -500.00 +/- 0.00 | 0.00 +/- 0.00 | 1.80 +/- 0.00 |
| `dqn` | 31.20 +/- 0.00 | 51.40 +/- 0.00 | 20.20 +/- 0.00 | -500.00 +/- 0.00 | 0.00 +/- 0.00 | 20.20 +/- 0.00 |
| `a2c` | 42.80 +/- 0.00 | 52.80 +/- 0.00 | 10.00 +/- 0.00 | -216.20 +/- 0.00 | 0.00 +/- 0.00 | 10.00 +/- 0.00 |

- Retention delta is CartPole final return after the second task minus CartPole return immediately after CartPole training.
- Negative BWT and positive forgetting indicate catastrophic forgetting on the earlier task.
