"""The Alberta controller must actually learn a single reach task online.

This is the functional contract the continual benchmark stands on: if the agent
cannot improve on one task, BWT/forgetting numbers are meaningless. Kept small
enough to run on CPU in a few seconds.
"""

from __future__ import annotations

import os

os.environ.setdefault("JAX_PLATFORMS", "cpu")

from eliza_robot.rl.alberta.agent import AlbertaContinualController, AlbertaControllerConfig
from eliza_robot.rl.alberta.continual_env import JointReachConfig, JointReachEnv
from eliza_robot.rl.alberta.features import FeatureConfig
from eliza_robot.rl.alberta.loop import evaluate, train_online


def _controller(env: JointReachEnv) -> AlbertaContinualController:
    return AlbertaContinualController(
        AlbertaControllerConfig(
            obs_dim=int(env.observation_space.shape[0]),
            action_dim=int(env.action_space.shape[0]),
            gamma=0.5,
            actor_step_size=1e-2,
            critic_step_size=2e-2,
            actor_lamda=0.7,
            critic_lamda=0.7,
            log_sigma_init=-1.0,
            normalize=False,
            obgd_kappa=2.0,
            decouple_global_bias=True,
            features=FeatureConfig(
                mode="sparse_gated", embed_dim=16, n_prototypes=64, gate_hard=True, proprio_random_dim=64, seed=0
            ),
            seed=0,
        )
    )


def test_controller_learns_single_task():
    env = JointReachEnv(n_tasks=4, config=JointReachConfig(n_joints=4))
    ctrl = _controller(env)
    env.set_task(0)
    before = evaluate(ctrl, env, 5, seed=999).mean_return
    train_online(ctrl, env, 12000, seed=0)
    after = evaluate(ctrl, env, 5, seed=999).mean_return
    # Returns are bounded in [0, episode_steps]; learning must lift the greedy
    # policy meaningfully above the do-nothing baseline.
    assert after > before + 3.0


def test_state_dict_roundtrip_preserves_policy():
    import numpy as np

    env = JointReachEnv(n_tasks=2, config=JointReachConfig(n_joints=3))
    ctrl = _controller(env)
    env.set_task(0)
    train_online(ctrl, env, 4000, seed=0)
    obs, _ = env.reset(seed=7)
    a1 = ctrl.act_greedy(obs)
    snap = ctrl.state_dict()

    ctrl2 = _controller(env)
    ctrl2.load_state_dict(snap)
    a2 = ctrl2.act_greedy(obs)
    assert np.allclose(a1, a2, atol=1e-5)
