"""Fast continual-learning obstacle-course env.

The full humanoid obstacle course belongs in MuJoCo/Nebius. This env is the
CPU-cheap proof harness: a point robot must move down a corridor while choosing
the task-conditioned lane that avoids a central obstacle. The lane target is
hidden behind the task embedding, so sequential training measures the same
failure mode as the robot policy: learn a new command/course without overwriting
the embedding -> behaviour mapping learned for earlier courses.
"""

from __future__ import annotations

from dataclasses import dataclass

import gymnasium as gym
import numpy as np


@dataclass(frozen=True)
class ObstacleCourseConfig:
    embed_dim: int = 16
    episode_steps: int = 80
    dt: float = 0.08
    action_scale: float = 1.2
    course_length_m: float = 2.4
    lane_y_m: float = 0.75
    lane_width_m: float = 0.25
    obstacle_radius_m: float = 0.28
    obstacle_x_m: float = 0.0
    obstacle_y_m: float = 0.0
    goal_tolerance_m: float = 0.18
    embed_seed: int = 24680


class ObstacleCourseEnv(gym.Env):
    """Task-conditioned 2D obstacle course.

    Observation::
        [x, y, vx, vy, obstacle_dx, obstacle_dy, obstacle_radius, task_embedding]

    Action::
        [-1, +1] planar acceleration command.

    Each task picks a lane side and mild lane offset. The active route is not
    directly observed; it is recoverable only from the trailing task embedding.
    """

    metadata = {"render_modes": []}

    def __init__(
        self,
        n_tasks: int,
        config: ObstacleCourseConfig | None = None,
        *,
        task_pool: list[int] | None = None,
        seed: int = 0,
    ) -> None:
        super().__init__()
        self.config = config or ObstacleCourseConfig()
        self.n_tasks = int(n_tasks)
        self.task_pool = list(task_pool) if task_pool is not None else list(range(n_tasks))
        if not self.task_pool:
            raise ValueError("task_pool must contain at least one task")

        gen = np.random.default_rng(self.config.embed_seed)
        signs = np.array([1.0 if i % 2 == 0 else -1.0 for i in range(n_tasks)])
        offsets = gen.uniform(-0.18, 0.18, size=n_tasks)
        self._lanes = (signs * self.config.lane_y_m + offsets).astype(np.float32)
        self._embeddings = gen.standard_normal((n_tasks, self.config.embed_dim)).astype(
            np.float32
        )

        obs_dim = 7 + self.config.embed_dim
        self.observation_space = gym.spaces.Box(-np.inf, np.inf, (obs_dim,), np.float32)
        self.action_space = gym.spaces.Box(-1.0, 1.0, (2,), np.float32)

        self._task = self.task_pool[0]
        self._forced_task: int | None = None
        self._pos = np.zeros(2, dtype=np.float32)
        self._vel = np.zeros(2, dtype=np.float32)
        self._step = 0
        self._prev_goal_dist = 0.0

    def set_task(self, task_id: int) -> None:
        if task_id < 0 or task_id >= self.n_tasks:
            raise ValueError(f"task_id {task_id} outside 0..{self.n_tasks - 1}")
        self._forced_task = int(task_id)

    def clear_forced_task(self) -> None:
        self._forced_task = None

    @property
    def target_lane_y(self) -> float:
        return float(self._lanes[self._task])

    @property
    def goal(self) -> np.ndarray:
        return np.array(
            [self.config.course_length_m / 2.0, self.target_lane_y],
            dtype=np.float32,
        )

    def reset(self, *, seed: int | None = None, options: dict | None = None):
        super().reset(seed=seed)
        if self._forced_task is not None:
            self._task = self._forced_task
        else:
            self._task = int(self.task_pool[self.np_random.integers(len(self.task_pool))])
        start_x = -self.config.course_length_m / 2.0
        self._pos = np.array(
            [
                start_x + float(self.np_random.uniform(-0.03, 0.03)),
                float(self.np_random.uniform(-0.12, 0.12)),
            ],
            dtype=np.float32,
        )
        self._vel = np.zeros(2, dtype=np.float32)
        self._step = 0
        self._prev_goal_dist = self._goal_dist()
        return self._obs(), {"task_id": self._task, "lane_y": self.target_lane_y}

    def step(self, action: np.ndarray):
        cfg = self.config
        a = np.clip(np.asarray(action, dtype=np.float32), -1.0, 1.0)
        self._vel = np.clip(
            0.82 * self._vel + cfg.action_scale * a * cfg.dt,
            -1.2,
            1.2,
        ).astype(np.float32)
        self._pos = (self._pos + self._vel * cfg.dt).astype(np.float32)
        self._step += 1

        goal_dist = self._goal_dist()
        progress = self._prev_goal_dist - goal_dist
        self._prev_goal_dist = goal_dist

        lane_err = abs(float(self._pos[1]) - self.target_lane_y)
        lane_reward = float(np.exp(-lane_err / max(cfg.lane_width_m, 1e-6)))
        forward_reward = 1.5 * progress + 0.02 * float(self._vel[0])
        control_penalty = 0.01 * float(np.dot(a, a))

        obstacle_dist = self._obstacle_dist()
        collision = obstacle_dist < cfg.obstacle_radius_m
        collision_penalty = 1.5 if collision else 0.0
        goal_bonus = 3.0 if goal_dist < cfg.goal_tolerance_m else 0.0

        reward = forward_reward + 0.08 * lane_reward + goal_bonus - control_penalty - collision_penalty
        truncated = self._step >= cfg.episode_steps
        terminated = bool(collision or goal_bonus > 0.0)
        return (
            self._obs(),
            float(reward),
            terminated,
            truncated,
            {
                "task_id": self._task,
                "lane_y": self.target_lane_y,
                "goal_dist": goal_dist,
                "obstacle_dist": obstacle_dist,
                "collision": collision,
            },
        )

    def _goal_dist(self) -> float:
        return float(np.linalg.norm(self._pos - self.goal))

    def _obstacle_dist(self) -> float:
        c = self.config
        obstacle = np.array([c.obstacle_x_m, c.obstacle_y_m], dtype=np.float32)
        return float(np.linalg.norm(self._pos - obstacle))

    def _obs(self) -> np.ndarray:
        c = self.config
        obstacle_rel = np.array(
            [c.obstacle_x_m - self._pos[0], c.obstacle_y_m - self._pos[1]],
            dtype=np.float32,
        )
        body = np.concatenate(
            [
                self._pos,
                self._vel,
                obstacle_rel,
                np.array([c.obstacle_radius_m], dtype=np.float32),
            ]
        )
        return np.concatenate([body, self._embeddings[self._task]]).astype(np.float32)


def make_obstacle_course_env(
    n_tasks: int,
    config: ObstacleCourseConfig | None = None,
    *,
    task_pool: list[int] | None = None,
    seed: int = 0,
) -> ObstacleCourseEnv:
    return ObstacleCourseEnv(n_tasks, config, task_pool=task_pool, seed=seed)
