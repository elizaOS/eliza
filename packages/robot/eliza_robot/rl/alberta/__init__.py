"""Alberta-Plan continual learning for robot control.

This subpackage integrates the vendored Alberta framework (``packages/alberta``)
into the robot RL stack. It provides a streaming, continual-learning controller
that learns a sequence of robot tasks **without catastrophically forgetting**
earlier ones — the failure mode that cripples standard RL (PPO) when tasks are
trained one after another.

Public surface:

- :class:`AlbertaContinualController` / :class:`AlbertaControllerConfig` — the
  streaming continuous-action controller (Alberta actor-critic + ObGD bounding +
  a sparse, task-localized feature lift).
- :func:`train_online` / :func:`evaluate` — online act->update control loops for
  any ``gymnasium.Env``.
- :class:`JointReachEnv` — a fast, deterministic task-conditioned continual env.
- :class:`ObstacleCourseEnv` — a fast task-conditioned route-retention env.
- :func:`compute_continual_metrics` — ACC / BWT / Forgetting / FWT.
- :func:`run_benchmark` — the Alberta-vs-PPO continual-learning head-to-head.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

if importlib.util.find_spec("alberta_framework") is None:
    vendored = Path(__file__).resolve().parents[4] / "alberta"
    if (vendored / "alberta_framework").is_dir():
        sys.path.insert(0, str(vendored))

from eliza_robot.rl.alberta.agent import (
    AlbertaContinualController,
    AlbertaControllerConfig,
)
from eliza_robot.rl.alberta.continual_env import (
    JointReachConfig,
    JointReachEnv,
    make_joint_reach_env,
)
from eliza_robot.rl.alberta.features import FeatureConfig, FeatureMap
from eliza_robot.rl.alberta.loop import EvalStats, TrainStats, evaluate, train_online
from eliza_robot.rl.alberta.metrics import ContinualMetrics, compute_continual_metrics
from eliza_robot.rl.alberta.obstacle_course import (
    ObstacleCourseConfig,
    ObstacleCourseEnv,
    make_obstacle_course_env,
)

__all__ = [
    "AlbertaContinualController",
    "AlbertaControllerConfig",
    "FeatureConfig",
    "FeatureMap",
    "JointReachConfig",
    "JointReachEnv",
    "make_joint_reach_env",
    "ObstacleCourseConfig",
    "ObstacleCourseEnv",
    "make_obstacle_course_env",
    "TrainStats",
    "EvalStats",
    "train_online",
    "evaluate",
    "ContinualMetrics",
    "compute_continual_metrics",
]
