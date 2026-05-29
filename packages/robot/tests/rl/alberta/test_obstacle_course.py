from __future__ import annotations

import os

os.environ.setdefault("JAX_PLATFORMS", "cpu")

import numpy as np

from eliza_robot.rl.alberta.agent import AlbertaContinualController, AlbertaControllerConfig
from eliza_robot.rl.alberta.benchmark import BenchmarkConfig, _build_env, run_learner
from eliza_robot.rl.alberta.features import FeatureConfig
from eliza_robot.rl.alberta.loop import evaluate, train_online
from eliza_robot.rl.alberta.metrics import compute_continual_metrics
from eliza_robot.rl.alberta.obstacle_course import ObstacleCourseConfig, ObstacleCourseEnv


def _controller(env: ObstacleCourseEnv) -> AlbertaContinualController:
    return AlbertaContinualController(
        AlbertaControllerConfig(
            obs_dim=int(env.observation_space.shape[0]),
            action_dim=int(env.action_space.shape[0]),
            gamma=0.7,
            actor_step_size=8e-3,
            critic_step_size=1.5e-2,
            actor_lamda=0.7,
            critic_lamda=0.7,
            log_sigma_init=-0.8,
            normalize=False,
            obgd_kappa=2.0,
            decouple_global_bias=True,
            features=FeatureConfig(
                mode="sparse_gated",
                embed_dim=16,
                n_prototypes=96,
                gate_hard=True,
                proprio_random_dim=48,
                seed=11,
            ),
            seed=11,
        )
    )


def test_obstacle_course_contract_and_task_embedding_shape() -> None:
    env = ObstacleCourseEnv(
        n_tasks=4,
        config=ObstacleCourseConfig(embed_dim=16, episode_steps=10),
        seed=0,
    )
    obs, info = env.reset(seed=1)
    assert obs.shape == env.observation_space.shape
    assert env.action_space.shape == (2,)
    assert info["task_id"] in range(4)
    assert np.isfinite(obs).all()

    env.set_task(1)
    obs_a, info_a = env.reset(seed=2)
    env.set_task(2)
    obs_b, info_b = env.reset(seed=2)
    assert info_a["task_id"] == 1
    assert info_b["task_id"] == 2
    assert not np.allclose(obs_a[-16:], obs_b[-16:])
    assert info_a["lane_y"] != info_b["lane_y"]


def test_obstacle_course_alberta_improves_single_route() -> None:
    env = ObstacleCourseEnv(
        n_tasks=4,
        config=ObstacleCourseConfig(embed_dim=16, episode_steps=50),
        seed=0,
    )
    ctrl = _controller(env)
    env.set_task(0)
    before = evaluate(ctrl, env, 3, seed=500).mean_return
    train_online(ctrl, env, 2500, seed=0)
    after = evaluate(ctrl, env, 3, seed=500).mean_return
    assert after > before + 0.5


def test_obstacle_course_benchmark_matrix_retains() -> None:
    from eliza_robot.rl.alberta.baselines import AlbertaSequentialLearner

    cfg = BenchmarkConfig(
        env_kind="obstacle_course",
        n_tasks=2,
        steps_per_task=2500,
        eval_episodes=3,
        seeds=1,
        embed_dim=16,
        n_prototypes=96,
        proprio_random_dim=48,
        obstacle_episode_steps=50,
    )
    env = _build_env(cfg, seed=123)
    learner = AlbertaSequentialLearner(
        env,
        AlbertaControllerConfig(
            obs_dim=int(env.observation_space.shape[0]),
            action_dim=int(env.action_space.shape[0]),
            gamma=cfg.gamma,
            actor_step_size=cfg.actor_step_size,
            critic_step_size=cfg.critic_step_size,
            actor_lamda=cfg.actor_lamda,
            critic_lamda=cfg.critic_lamda,
            log_sigma_init=cfg.log_sigma_init,
            normalize=False,
            obgd_kappa=2.0,
            decouple_global_bias=True,
            features=FeatureConfig(
                mode="sparse_gated",
                embed_dim=cfg.embed_dim,
                n_prototypes=cfg.n_prototypes,
                gate_hard=True,
                proprio_random_dim=cfg.proprio_random_dim,
                seed=123,
            ),
            seed=123,
        ),
    )
    R, baseline, baseline_motion, motion_matrix, trajectory_matrix = run_learner(
        learner, cfg
    )
    metrics = compute_continual_metrics(R, baseline)
    assert R.shape == (2, 2)
    assert len(baseline_motion) == 2
    assert len(motion_matrix) == 2
    assert len(trajectory_matrix) == 2
    assert all(len(row) == 2 for row in motion_matrix)
    assert all(len(row) == 2 for row in trajectory_matrix)
    assert all("steps" in trace for row in trajectory_matrix for trace in row)
    assert np.isfinite(R).all()
    assert metrics.forgetting >= 0.0
    task0_peak = max(R[0, 0], R[1, 0])
    assert R[1, 0] >= 0.35 * max(task0_peak, 1e-6)
