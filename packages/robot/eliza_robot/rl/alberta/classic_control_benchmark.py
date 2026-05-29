"""Classic-control continual benchmark for CartPole retention.

This harness answers a narrower question than the robot benchmark:

1. Train/evaluate on ``CartPole-v1``.
2. Train the same learner on another simple Gymnasium task.
3. Re-evaluate ``CartPole-v1`` to measure catastrophic forgetting.

All phases expose one padded observation space and one shared discrete action
space so each baseline keeps a single policy across tasks.
"""

from __future__ import annotations

import argparse
import json
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import gymnasium as gym
import jax
import jax.numpy as jnp
import numpy as np
from alberta_framework import ObGDBounding, SARSAAgent, SARSAConfig
from gymnasium import spaces

from eliza_robot.rl.alberta.features import FeatureConfig, FeatureMap
from eliza_robot.rl.alberta.metrics import compute_continual_metrics


@dataclass(frozen=True)
class ClassicControlTask:
    env_id: str
    max_episode_steps: int


@dataclass
class ClassicControlBenchmarkConfig:
    first_task: str = "CartPole-v1"
    second_task: str = "Acrobot-v1"
    steps_first_task: int = 10_000
    steps_second_task: int = 10_000
    eval_episodes: int = 10
    seeds: int = 1
    learners: tuple[str, ...] = ("alberta", "ppo", "dqn", "a2c")
    n_prototypes: int = 64
    proprio_random_dim: int = 16


TASKS: dict[str, ClassicControlTask] = {
    "CartPole-v1": ClassicControlTask("CartPole-v1", 500),
    "Acrobot-v1": ClassicControlTask("Acrobot-v1", 500),
    "MountainCar-v0": ClassicControlTask("MountainCar-v0", 200),
}


class SharedClassicControlEnv(gym.Env):
    """A task-switchable env with padded observations and shared actions."""

    metadata = {"render_modes": []}

    def __init__(self, task_ids: list[str], seed: int = 0):
        if not task_ids:
            raise ValueError("task_ids must not be empty")
        unknown = sorted(set(task_ids) - TASKS.keys())
        if unknown:
            raise ValueError(f"unknown classic-control task(s): {', '.join(unknown)}")
        self.task_ids = list(task_ids)
        self._seed = int(seed)
        self._task_index = 0
        self._envs = [gym.make(TASKS[task_id].env_id) for task_id in self.task_ids]
        self._obs_dims = [int(env.observation_space.shape[0]) for env in self._envs]
        self._action_sizes = [int(env.action_space.n) for env in self._envs]
        self._max_obs_dim = max(self._obs_dims)
        self._task_one_hot_dim = len(self._envs)
        self._max_action_size = max(self._action_sizes)
        self.observation_space = spaces.Box(
            low=-np.inf,
            high=np.inf,
            shape=(self._max_obs_dim + self._task_one_hot_dim,),
            dtype=np.float32,
        )
        self.action_space = spaces.Discrete(self._max_action_size)

    @property
    def task_id(self) -> str:
        return self.task_ids[self._task_index]

    def set_task(self, task_index: int) -> None:
        if task_index < 0 or task_index >= len(self._envs):
            raise ValueError(f"task_index out of range: {task_index}")
        self._task_index = int(task_index)

    def _pad_obs(self, obs: np.ndarray) -> np.ndarray:
        padded = np.zeros((self._max_obs_dim + self._task_one_hot_dim,), dtype=np.float32)
        raw = np.asarray(obs, dtype=np.float32).reshape(-1)
        padded[: raw.shape[0]] = raw
        padded[self._max_obs_dim + self._task_index] = 1.0
        return padded

    def _map_action(self, action: int | np.ndarray) -> int:
        raw = int(np.asarray(action).reshape(-1)[0])
        return int(np.clip(raw, 0, self._action_sizes[self._task_index] - 1))

    def reset(self, *, seed: int | None = None, options: dict | None = None):
        env_seed = self._seed + self._task_index if seed is None else int(seed)
        obs, info = self._envs[self._task_index].reset(seed=env_seed, options=options)
        return self._pad_obs(obs), info

    def step(self, action):
        obs, reward, terminated, truncated, info = self._envs[self._task_index].step(
            self._map_action(action)
        )
        return self._pad_obs(obs), float(reward), bool(terminated), bool(truncated), info

    def close(self) -> None:
        for env in self._envs:
            env.close()


class AlbertaDiscreteLearner:
    name = "alberta"

    def __init__(self, env: SharedClassicControlEnv, seed: int, cfg: ClassicControlBenchmarkConfig):
        self.env = env
        self._eval_seed = 50_000 + seed
        self._feature_map = FeatureMap(
            FeatureConfig(
                mode="sparse_gated",
                embed_dim=len(env.task_ids),
                n_prototypes=cfg.n_prototypes,
                gate_hard=True,
                gate_temperature=0.1,
                proprio_random_dim=cfg.proprio_random_dim,
                seed=seed,
            ),
            input_dim=int(env.observation_space.shape[0]),
        )
        total_steps = max(1, cfg.steps_first_task + cfg.steps_second_task)
        self._agent = SARSAAgent(
            SARSAConfig(
                n_actions=env.action_space.n,
                gamma=0.99,
                epsilon_start=0.2,
                epsilon_end=0.02,
                epsilon_decay_steps=total_steps,
            ),
            hidden_sizes=(64,),
            step_size=0.03,
            bounder=ObGDBounding(kappa=2.0),
            sparsity=0.75,
            use_layer_norm=True,
            lamda=0.8,
        )
        self._state = self._agent.init(self._feature_map.feature_dim, jax.random.key(seed))

    def _features(self, obs: np.ndarray) -> jax.Array:
        return self._feature_map(jnp.asarray(obs, dtype=jnp.float32))

    def _select_action(self, obs_features: jax.Array, task_index: int) -> tuple[jax.Array, jax.Array]:
        key, explore_key, noise_key, random_key = jax.random.split(self._state.rng_key, 4)
        q_values = self._agent.horde.predict(self._state.learner_state, obs_features)
        valid_actions = self.env._action_sizes[task_index]
        masked_q = q_values[:valid_actions]
        gumbel_noise = jax.random.gumbel(noise_key, shape=masked_q.shape) * 1e-6
        greedy_action = jnp.argmax(masked_q + gumbel_noise).astype(jnp.int32)
        random_action = jax.random.randint(random_key, (), 0, valid_actions).astype(jnp.int32)
        action = jax.lax.select(
            jax.random.uniform(explore_key) < self._state.epsilon,
            random_action,
            greedy_action,
        )
        return action, key

    def train_phase(self, task_index: int, steps: int, seed: int) -> None:
        self.env.set_task(task_index)
        obs, _ = self.env.reset(seed=seed + task_index)
        feat = self._features(obs)
        action, rng_key = self._select_action(feat, task_index)
        self._state = self._state.replace(
            last_action=action,
            last_observation=feat,
            rng_key=rng_key,
        )
        for _ in range(steps):
            obs, reward, terminated, truncated, _ = self.env.step(int(action))
            boundary = bool(terminated or truncated)
            if boundary:
                obs, _ = self.env.reset()
            feat = self._features(obs)
            next_action, rng_key = self._select_action(feat, task_index)
            update_state = self._state.replace(rng_key=rng_key)
            result = self._agent.update(
                update_state,
                jnp.asarray(reward, dtype=jnp.float32),
                feat,
                jnp.asarray(boundary, dtype=jnp.bool_),
                next_action,
            )
            self._state = result.state
            action = next_action

    def _greedy_action(self, obs: np.ndarray, task_index: int) -> int:
        q_values = self._agent.horde.predict(self._state.learner_state, self._features(obs))
        valid_actions = self.env._action_sizes[task_index]
        return int(jnp.argmax(q_values[:valid_actions]))

    def eval_task(self, task_index: int, episodes: int) -> dict[str, Any]:
        self.env.set_task(task_index)
        returns: list[float] = []
        lengths: list[int] = []
        for ep in range(episodes):
            obs, _ = self.env.reset(seed=self._eval_seed + task_index * 1000 + ep)
            done = False
            total = 0.0
            length = 0
            while not done:
                action = self._greedy_action(obs, task_index)
                obs, reward, terminated, truncated, _ = self.env.step(action)
                total += float(reward)
                length += 1
                done = bool(terminated or truncated)
            returns.append(total)
            lengths.append(length)
        return _eval_stats(returns, lengths, episodes)


class SB3DiscreteLearner:
    def __init__(self, name: str, env: SharedClassicControlEnv, seed: int):
        self.name = name
        self.env = env
        self._eval_seed = 60_000 + seed
        if name == "ppo":
            from stable_baselines3 import PPO

            self._model = PPO(
                "MlpPolicy",
                env,
                seed=seed,
                n_steps=512,
                batch_size=128,
                learning_rate=3e-4,
                gamma=0.99,
                policy_kwargs={"net_arch": [128, 128]},
                verbose=0,
                device="cpu",
            )
        elif name == "dqn":
            from stable_baselines3 import DQN

            self._model = DQN(
                "MlpPolicy",
                env,
                seed=seed,
                learning_rate=1e-3,
                buffer_size=50_000,
                learning_starts=100,
                batch_size=64,
                train_freq=4,
                gamma=0.99,
                policy_kwargs={"net_arch": [128, 128]},
                verbose=0,
                device="cpu",
            )
        elif name == "a2c":
            from stable_baselines3 import A2C

            self._model = A2C(
                "MlpPolicy",
                env,
                seed=seed,
                learning_rate=7e-4,
                gamma=0.99,
                policy_kwargs={"net_arch": [128, 128]},
                verbose=0,
                device="cpu",
            )
        else:
            raise ValueError(f"unsupported SB3 learner {name!r}")

    def train_phase(self, task_index: int, steps: int, seed: int) -> None:
        self.env.set_task(task_index)
        self._model.learn(total_timesteps=steps, reset_num_timesteps=False, progress_bar=False)

    def eval_task(self, task_index: int, episodes: int) -> dict[str, Any]:
        self.env.set_task(task_index)
        returns: list[float] = []
        lengths: list[int] = []
        for ep in range(episodes):
            obs, _ = self.env.reset(seed=self._eval_seed + task_index * 1000 + ep)
            done = False
            total = 0.0
            length = 0
            while not done:
                action, _ = self._model.predict(obs, deterministic=True)
                obs, reward, terminated, truncated, _ = self.env.step(action)
                total += float(reward)
                length += 1
                done = bool(terminated or truncated)
            returns.append(total)
            lengths.append(length)
        return _eval_stats(returns, lengths, episodes)


def _eval_stats(returns: list[float], lengths: list[int], episodes: int) -> dict[str, Any]:
    return {
        "episodes": episodes,
        "mean_return": float(np.mean(returns)) if returns else 0.0,
        "std_return": float(np.std(returns)) if returns else 0.0,
        "mean_length": float(np.mean(lengths)) if lengths else 0.0,
        "returns": [float(x) for x in returns],
    }


def _build_learner(
    name: str,
    env: SharedClassicControlEnv,
    seed: int,
    cfg: ClassicControlBenchmarkConfig,
):
    if name == "alberta":
        return AlbertaDiscreteLearner(env, seed, cfg)
    if name in {"ppo", "dqn", "a2c"}:
        return SB3DiscreteLearner(name, env, seed)
    raise ValueError(f"unknown learner {name!r}")


def run_benchmark(cfg: ClassicControlBenchmarkConfig, out_dir: Path) -> dict[str, Any]:
    if cfg.first_task == cfg.second_task:
        raise ValueError("first_task and second_task must differ")
    task_ids = [cfg.first_task, cfg.second_task]
    out_dir.mkdir(parents=True, exist_ok=True)
    requested = tuple(dict.fromkeys(cfg.learners))
    unsupported = sorted(set(requested) - {"alberta", "ppo", "dqn", "a2c"})
    if unsupported:
        raise ValueError(f"unknown learner(s): {', '.join(unsupported)}")
    if "alberta" not in requested:
        raise ValueError("classic-control evidence must include alberta")

    results: list[dict[str, Any]] = []
    summaries: dict[str, list[dict[str, float]]] = {name: [] for name in requested}
    for seed_offset in range(cfg.seeds):
        seed = 7_000 + seed_offset
        for name in requested:
            env = SharedClassicControlEnv(task_ids, seed=seed)
            learner = _build_learner(name, env, seed, cfg)
            baseline = [learner.eval_task(i, cfg.eval_episodes) for i in range(2)]
            matrix = np.zeros((2, 2), dtype=np.float64)
            phase_evals: list[list[dict[str, Any]]] = []
            for phase, steps in enumerate((cfg.steps_first_task, cfg.steps_second_task)):
                learner.train_phase(phase, steps, seed)
                evals = [learner.eval_task(i, cfg.eval_episodes) for i in range(2)]
                phase_evals.append(evals)
                matrix[phase] = [item["mean_return"] for item in evals]
            metrics = compute_continual_metrics(
                matrix,
                np.asarray([item["mean_return"] for item in baseline], dtype=np.float64),
            )
            cartpole_after_first = float(matrix[0, 0])
            cartpole_after_second = float(matrix[1, 0])
            summary = {
                "acc": metrics.acc,
                "bwt": metrics.bwt,
                "forgetting": metrics.forgetting,
                "fwt": metrics.fwt,
                "cartpole_after_first": cartpole_after_first,
                "cartpole_after_second": cartpole_after_second,
                "cartpole_retention_delta": cartpole_after_second - cartpole_after_first,
                "second_task_after_second": float(matrix[1, 1]),
            }
            summaries[name].append(summary)
            results.append(
                {
                    "learner": name,
                    "seed": seed,
                    "baseline": baseline,
                    "phase_evals": phase_evals,
                    "matrix": matrix.tolist(),
                    "metrics": metrics.to_dict(),
                    "summary": summary,
                }
            )
            env.close()
            print(
                f"[seed {seed}] {name:7s} CartPole {cartpole_after_first:.1f} -> "
                f"{cartpole_after_second:.1f}; second task {matrix[1, 1]:.1f}; "
                f"forgetting={metrics.forgetting:.1f}",
                flush=True,
            )

    aggregate = _aggregate(summaries)
    bundle = {
        "config": {
            **asdict(cfg),
            "learners": list(cfg.learners),
            "note": (
                "Alberta uses the vendored discrete SARSAAgent with sparse-gated "
                "task-local features and task-valid action masking. "
                "PPO, DQN, and A2C are strong standard Stable-Baselines3 classic-control "
                "baselines here, not a leaderboard claim for all possible CartPole solvers."
            ),
        },
        "tasks": task_ids,
        "aggregate": aggregate,
        "results": results,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    (out_dir / "classic_control_forgetting.json").write_text(json.dumps(bundle, indent=2))
    _write_report(bundle, out_dir)
    return bundle


def _aggregate(summaries: dict[str, list[dict[str, float]]]) -> dict[str, dict[str, dict[str, float]]]:
    aggregate: dict[str, dict[str, dict[str, float]]] = {}
    for learner, rows in summaries.items():
        if not rows:
            continue
        aggregate[learner] = {
            key: {
                "mean": float(np.mean([row[key] for row in rows])),
                "std": float(np.std([row[key] for row in rows])),
            }
            for key in rows[0]
        }
    return aggregate


def _fmt_metric(aggregate: dict, learner: str, key: str) -> str:
    item = aggregate.get(learner, {}).get(key)
    if not item:
        return "n/a"
    return f"{item['mean']:.2f} +/- {item['std']:.2f}"


def _write_report(bundle: dict[str, Any], out_dir: Path) -> None:
    cfg = bundle["config"]
    aggregate = bundle["aggregate"]
    learners = cfg["learners"]
    lines = [
        "# Classic-control catastrophic-forgetting benchmark",
        "",
        f"Training order: `{cfg['first_task']}` then `{cfg['second_task']}`.",
        "",
        f"Steps: first task `{cfg['steps_first_task']}`, second task "
        f"`{cfg['steps_second_task']}`; eval episodes `{cfg['eval_episodes']}`; "
        f"seeds `{cfg['seeds']}`.",
        "",
        "Alberta is run through the vendored discrete `SARSAAgent` with sparse-gated "
        "task-local features and task-valid action masking.",
        "",
        "PPO, DQN, and A2C are used as strong standard Stable-Baselines3 baselines "
        "for classic-control comparison. This is a reproducible local SOTA-style "
        "baseline set, not a claim about the absolute CartPole leaderboard.",
        "",
        "| learner | CartPole after CartPole | CartPole after second task | retention delta | second-task final | forgetting | BWT |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ]
    for learner in learners:
        lines.append(
            f"| `{learner}` | {_fmt_metric(aggregate, learner, 'cartpole_after_first')} | "
            f"{_fmt_metric(aggregate, learner, 'cartpole_after_second')} | "
            f"{_fmt_metric(aggregate, learner, 'cartpole_retention_delta')} | "
            f"{_fmt_metric(aggregate, learner, 'second_task_after_second')} | "
            f"{_fmt_metric(aggregate, learner, 'forgetting')} | "
            f"{_fmt_metric(aggregate, learner, 'bwt')} |"
        )
    lines += [
        "",
        "- Retention delta is CartPole final return after the second task minus CartPole return immediately after CartPole training.",
        "- Negative BWT and positive forgetting indicate catastrophic forgetting on the earlier task.",
    ]
    (out_dir / "classic_control_forgetting.md").write_text("\n".join(lines) + "\n")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--first-task", choices=sorted(TASKS), default="CartPole-v1")
    parser.add_argument("--second-task", choices=sorted(TASKS), default="Acrobot-v1")
    parser.add_argument("--steps-first-task", type=int, default=10_000)
    parser.add_argument("--steps-second-task", type=int, default=10_000)
    parser.add_argument("--eval-episodes", type=int, default=10)
    parser.add_argument("--seeds", type=int, default=1)
    parser.add_argument(
        "--learners",
        nargs="+",
        choices=("alberta", "ppo", "dqn", "a2c"),
        default=list(ClassicControlBenchmarkConfig.learners),
    )
    parser.add_argument("--out-dir", default="evidence/classic_control_forgetting")
    args = parser.parse_args(argv)
    cfg = ClassicControlBenchmarkConfig(
        first_task=args.first_task,
        second_task=args.second_task,
        steps_first_task=args.steps_first_task,
        steps_second_task=args.steps_second_task,
        eval_episodes=args.eval_episodes,
        seeds=args.seeds,
        learners=tuple(args.learners),
    )
    bundle = run_benchmark(cfg, Path(args.out_dir))
    print("\n=== CLASSIC CONTROL SUMMARY ===")
    for learner, metrics in bundle["aggregate"].items():
        print(
            f"{learner:7s} CartPole {_fmt_metric(bundle['aggregate'], learner, 'cartpole_after_first')} "
            f"-> {_fmt_metric(bundle['aggregate'], learner, 'cartpole_after_second')}; "
            f"forgetting={metrics['forgetting']['mean']:.2f}"
        )


if __name__ == "__main__":
    main()
