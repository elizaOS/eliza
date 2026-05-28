"""Sequential learners for the continual-learning head-to-head.

Both learners expose the same tiny protocol — ``train_phase`` / ``eval_task`` —
so the benchmark harness drives them identically and the only variable is the
learning algorithm:

- :class:`AlbertaSequentialLearner` — the Alberta-Plan streaming controller,
  updated online every step, weights persisted across the whole task stream.
- :class:`PPOSequentialLearner` — standard on-policy RL (Stable-Baselines3 PPO).
  The model is *warm-started* across phases (``reset_num_timesteps=False``); it
  is the same network learning each new task in turn, which is precisely the
  setup under which PPO catastrophically forgets.
- :class:`SACSequentialLearner` — standard off-policy maximum-entropy RL
  (Stable-Baselines3 SAC), also warm-started across phases. This gives the
  harness a second non-Alberta robot baseline without changing the required
  Alberta-vs-PPO evidence contract.

Critically, both see the **same env, the same per-task step budget, and the same
deterministic evaluation protocol** (greedy policy, fixed eval seeds).
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol

import numpy as np

from eliza_robot.rl.alberta.agent import AlbertaContinualController, AlbertaControllerConfig
from eliza_robot.rl.alberta.continual_env import JointReachEnv
from eliza_robot.rl.alberta.loop import evaluate, train_online


class SequentialLearner(Protocol):
    name: str

    def train_phase(self, task_id: int, steps: int) -> None: ...

    def eval_task(self, task_id: int, episodes: int) -> float: ...

    def eval_task_motion(self, task_id: int, episodes: int) -> dict[str, Any]: ...

    def eval_task_trace(self, task_id: int) -> dict[str, Any]: ...


@dataclass
class MotionEvalStats:
    episodes: int
    success_rate: float
    collision_rate: float
    passed_obstacle_rate: float
    mean_forward_progress_m: float
    mean_final_x: float
    mean_final_y: float
    mean_goal_dist: float
    min_obstacle_clearance_m: float
    mean_return: float
    mean_length: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "episodes": self.episodes,
            "success_rate": self.success_rate,
            "collision_rate": self.collision_rate,
            "passed_obstacle_rate": self.passed_obstacle_rate,
            "mean_forward_progress_m": self.mean_forward_progress_m,
            "mean_final_x": self.mean_final_x,
            "mean_final_y": self.mean_final_y,
            "mean_goal_dist": self.mean_goal_dist,
            "min_obstacle_clearance_m": self.min_obstacle_clearance_m,
            "mean_return": self.mean_return,
            "mean_length": self.mean_length,
        }


def _evaluate_motion(
    env: JointReachEnv,
    task_id: int,
    episodes: int,
    *,
    seed: int,
    action_fn: Callable[[np.ndarray], np.ndarray],
    trace_first_episode: bool = False,
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    env.set_task(task_id)
    returns: list[float] = []
    lengths: list[float] = []
    successes: list[float] = []
    collisions: list[float] = []
    passed: list[float] = []
    progress: list[float] = []
    final_x: list[float] = []
    final_y: list[float] = []
    goal_dists: list[float] = []
    clearances: list[float] = []
    trace: dict[str, Any] | None = None
    for ep in range(episodes):
        obs, reset_info = env.reset(seed=seed + task_id + ep)
        done = False
        ep_ret = 0.0
        ep_len = 0
        last_info: dict[str, Any] = dict(reset_info)
        min_clearance = float(reset_info.get("obstacle_clearance_m", float("inf")))
        collided = False
        if trace_first_episode and ep == 0:
            trace = {
                "task_id": int(task_id),
                "lane_y": float(reset_info.get("lane_y", np.nan)),
                "goal": [float(env.goal[0]), float(env.goal[1])] if hasattr(env, "goal") else None,
                "obstacle": {
                    "x": float(getattr(env.config, "obstacle_x_m", np.nan)),
                    "y": float(getattr(env.config, "obstacle_y_m", np.nan)),
                    "radius": float(getattr(env.config, "obstacle_radius_m", np.nan)),
                }
                if hasattr(env, "config")
                else None,
                "steps": [
                    {
                        "step": 0,
                        "x": float(reset_info.get("x", np.nan)),
                        "y": float(reset_info.get("y", np.nan)),
                        "vx": float(reset_info.get("vx", 0.0)),
                        "vy": float(reset_info.get("vy", 0.0)),
                        "reward": 0.0,
                        "collision": bool(reset_info.get("collision")),
                        "goal_reached": bool(reset_info.get("goal_reached")),
                        "passed_obstacle": bool(reset_info.get("passed_obstacle")),
                        "forward_progress_m": float(reset_info.get("forward_progress_m", 0.0)),
                        "obstacle_clearance_m": float(
                            reset_info.get("obstacle_clearance_m", np.nan)
                        ),
                    }
                ],
            }
        while not done:
            action = action_fn(np.asarray(obs, dtype=np.float32))
            obs, reward, terminated, truncated, info = env.step(action)
            last_info = dict(info)
            clearance = info.get("obstacle_clearance_m")
            if isinstance(clearance, int | float) and not isinstance(clearance, bool):
                min_clearance = min(min_clearance, float(clearance))
            collided = collided or bool(info.get("collision"))
            ep_ret += float(reward)
            ep_len += 1
            if trace is not None and ep == 0:
                trace["steps"].append(
                    {
                        "step": ep_len,
                        "x": float(last_info.get("x", np.nan)),
                        "y": float(last_info.get("y", np.nan)),
                        "vx": float(last_info.get("vx", np.nan)),
                        "vy": float(last_info.get("vy", np.nan)),
                        "reward": float(reward),
                        "collision": bool(last_info.get("collision")),
                        "goal_reached": bool(last_info.get("goal_reached")),
                        "passed_obstacle": bool(last_info.get("passed_obstacle")),
                        "forward_progress_m": float(
                            last_info.get("forward_progress_m", np.nan)
                        ),
                        "obstacle_clearance_m": float(
                            last_info.get("obstacle_clearance_m", np.nan)
                        ),
                    }
                )
            done = bool(terminated or truncated)
        returns.append(ep_ret)
        lengths.append(float(ep_len))
        successes.append(float(bool(last_info.get("goal_reached"))))
        collisions.append(float(collided))
        passed.append(float(bool(last_info.get("passed_obstacle"))))
        progress.append(float(last_info.get("forward_progress_m", 0.0)))
        final_x.append(float(last_info.get("x", 0.0)))
        final_y.append(float(last_info.get("y", 0.0)))
        goal_dists.append(float(last_info.get("goal_dist", 0.0)))
        clearances.append(min_clearance if np.isfinite(min_clearance) else 0.0)
    env.clear_forced_task()
    stats = MotionEvalStats(
        episodes=episodes,
        success_rate=float(np.mean(successes)) if successes else 0.0,
        collision_rate=float(np.mean(collisions)) if collisions else 0.0,
        passed_obstacle_rate=float(np.mean(passed)) if passed else 0.0,
        mean_forward_progress_m=float(np.mean(progress)) if progress else 0.0,
        mean_final_x=float(np.mean(final_x)) if final_x else 0.0,
        mean_final_y=float(np.mean(final_y)) if final_y else 0.0,
        mean_goal_dist=float(np.mean(goal_dists)) if goal_dists else 0.0,
        min_obstacle_clearance_m=float(np.min(clearances)) if clearances else 0.0,
        mean_return=float(np.mean(returns)) if returns else 0.0,
        mean_length=float(np.mean(lengths)) if lengths else 0.0,
    )
    stats_dict = stats.to_dict()
    if trace is not None:
        trace["summary"] = stats_dict
    return stats_dict, trace


def _eval_deterministic_env(env: JointReachEnv, task_id: int) -> None:
    env.set_task(task_id)


class AlbertaSequentialLearner:
    """Alberta streaming continual controller as a sequential learner."""

    name = "alberta"

    def __init__(self, env: JointReachEnv, controller_config: AlbertaControllerConfig):
        self.env = env
        self.controller = AlbertaContinualController(controller_config)
        self._eval_seed = 10_000

    def train_phase(self, task_id: int, steps: int) -> None:
        self.env.clear_forced_task()
        self.env.set_task(task_id)
        train_online(self.controller, self.env, steps, seed=task_id)

    def eval_task(self, task_id: int, episodes: int) -> float:
        self.env.set_task(task_id)
        stats = evaluate(self.controller, self.env, episodes, seed=self._eval_seed + task_id)
        self.env.clear_forced_task()
        return stats.mean_return

    def eval_task_motion(self, task_id: int, episodes: int) -> dict[str, Any]:
        stats, _trace = _evaluate_motion(
            self.env,
            task_id,
            episodes,
            seed=self._eval_seed,
            action_fn=lambda obs: self.controller.act_greedy(obs),
        )
        return stats

    def eval_task_trace(self, task_id: int) -> dict[str, Any]:
        _stats, trace = _evaluate_motion(
            self.env,
            task_id,
            1,
            seed=self._eval_seed,
            action_fn=lambda obs: self.controller.act_greedy(obs),
            trace_first_episode=True,
        )
        return trace or {}


class PPOSequentialLearner:
    """Stable-Baselines3 PPO warm-started across phases (the forgetting baseline)."""

    name = "ppo"

    def __init__(
        self,
        env: JointReachEnv,
        *,
        seed: int = 0,
        n_steps: int = 1024,
        batch_size: int = 256,
        learning_rate: float = 3e-4,
        gamma: float = 0.99,
        net_arch: tuple[int, ...] = (128, 128),
        verbose: int = 0,
    ):
        from stable_baselines3 import PPO

        self.env = env
        self._model = PPO(
            "MlpPolicy",
            env,
            seed=seed,
            n_steps=n_steps,
            batch_size=batch_size,
            learning_rate=learning_rate,
            gamma=gamma,
            policy_kwargs={"net_arch": list(net_arch)},
            verbose=verbose,
            device="cpu",
        )
        self._eval_seed = 10_000

    def train_phase(self, task_id: int, steps: int) -> None:
        self.env.clear_forced_task()
        self.env.set_task(task_id)
        self._model.learn(total_timesteps=steps, reset_num_timesteps=False, progress_bar=False)

    def eval_task(self, task_id: int, episodes: int) -> float:
        self.env.set_task(task_id)
        returns: list[float] = []
        for ep in range(episodes):
            obs, _ = self.env.reset(seed=self._eval_seed + task_id + ep)
            done = False
            ep_ret = 0.0
            while not done:
                action, _ = self._model.predict(obs, deterministic=True)
                obs, reward, terminated, truncated, _ = self.env.step(action)
                ep_ret += float(reward)
                done = bool(terminated or truncated)
            returns.append(ep_ret)
        self.env.clear_forced_task()
        return float(np.mean(returns)) if returns else 0.0

    def eval_task_motion(self, task_id: int, episodes: int) -> dict[str, Any]:
        stats, _trace = _evaluate_motion(
            self.env,
            task_id,
            episodes,
            seed=self._eval_seed,
            action_fn=lambda obs: self._model.predict(obs, deterministic=True)[0],
        )
        return stats

    def eval_task_trace(self, task_id: int) -> dict[str, Any]:
        _stats, trace = _evaluate_motion(
            self.env,
            task_id,
            1,
            seed=self._eval_seed,
            action_fn=lambda obs: self._model.predict(obs, deterministic=True)[0],
            trace_first_episode=True,
        )
        return trace or {}


class SACSequentialLearner:
    """Stable-Baselines3 SAC warm-started across phases."""

    name = "sac"

    def __init__(
        self,
        env: JointReachEnv,
        *,
        seed: int = 0,
        learning_rate: float = 3e-4,
        gamma: float = 0.99,
        buffer_size: int = 100_000,
        batch_size: int = 256,
        learning_starts: int = 100,
        train_freq: int = 1,
        gradient_steps: int = 1,
        net_arch: tuple[int, ...] = (128, 128),
        verbose: int = 0,
    ):
        from stable_baselines3 import SAC

        self.env = env
        self._model = SAC(
            "MlpPolicy",
            env,
            seed=seed,
            learning_rate=learning_rate,
            gamma=gamma,
            buffer_size=buffer_size,
            batch_size=batch_size,
            learning_starts=learning_starts,
            train_freq=train_freq,
            gradient_steps=gradient_steps,
            policy_kwargs={"net_arch": list(net_arch)},
            verbose=verbose,
            device="cpu",
        )
        self._eval_seed = 20_000

    def train_phase(self, task_id: int, steps: int) -> None:
        self.env.clear_forced_task()
        self.env.set_task(task_id)
        self._model.learn(total_timesteps=steps, reset_num_timesteps=False, progress_bar=False)

    def eval_task(self, task_id: int, episodes: int) -> float:
        self.env.set_task(task_id)
        returns: list[float] = []
        for ep in range(episodes):
            obs, _ = self.env.reset(seed=self._eval_seed + task_id + ep)
            done = False
            ep_ret = 0.0
            while not done:
                action, _ = self._model.predict(obs, deterministic=True)
                obs, reward, terminated, truncated, _ = self.env.step(action)
                ep_ret += float(reward)
                done = bool(terminated or truncated)
            returns.append(ep_ret)
        self.env.clear_forced_task()
        return float(np.mean(returns)) if returns else 0.0

    def eval_task_motion(self, task_id: int, episodes: int) -> dict[str, Any]:
        stats, _trace = _evaluate_motion(
            self.env,
            task_id,
            episodes,
            seed=self._eval_seed,
            action_fn=lambda obs: self._model.predict(obs, deterministic=True)[0],
        )
        return stats

    def eval_task_trace(self, task_id: int) -> dict[str, Any]:
        _stats, trace = _evaluate_motion(
            self.env,
            task_id,
            1,
            seed=self._eval_seed,
            action_fn=lambda obs: self._model.predict(obs, deterministic=True)[0],
            trace_first_episode=True,
        )
        return trace or {}
