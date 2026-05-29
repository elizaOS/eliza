from __future__ import annotations

import os
from pathlib import Path

os.environ.setdefault("JAX_PLATFORMS", "cpu")

import numpy as np

from eliza_robot.rl.alberta.cbp_agent import (
    AlbertaCBPController,
    CBPControllerConfig,
    RetentionConfig,
)
from eliza_robot.rl.alberta.checkpoint import load_state_npz, save_state_npz
from eliza_robot.rl.alberta.continual_env import JointReachConfig, JointReachEnv
from eliza_robot.rl.alberta.loop import train_online


def _controller(env: JointReachEnv) -> AlbertaCBPController:
    return AlbertaCBPController(
        CBPControllerConfig(
            obs_dim=int(env.observation_space.shape[0]),
            action_dim=int(env.action_space.shape[0]),
            hidden_sizes=(7, 5),
            gamma=0.5,
            actor_step_size=1e-2,
            critic_step_size=2e-2,
            actor_lamda=0.7,
            critic_lamda=0.7,
            log_sigma_init=-1.0,
            normalize=True,
            obgd_kappa=2.0,
            retention=RetentionConfig(mode="multihead", n_slots=8, embed_dim=4),
            seed=0,
        )
    )


def test_cbp_state_dict_roundtrips_through_object_free_npz(tmp_path: Path) -> None:
    env = JointReachEnv(n_tasks=2, config=JointReachConfig(n_joints=3, embed_dim=4))
    ctrl = _controller(env)
    env.set_task(0)
    train_online(ctrl, env, 32, seed=0)
    env.set_task(1)
    obs, _ = env.reset(seed=7)

    before_action = ctrl.act_greedy(obs)
    before_value = ctrl.value(obs)
    ckpt_path = tmp_path / "alberta_cbp_policy.npz"

    save_state_npz(ckpt_path, ctrl.state_dict())

    with np.load(ckpt_path, allow_pickle=False) as archive:
        assert all(archive[name].dtype != object for name in archive.files)

    restored = _controller(env)
    restored.load_state_dict(load_state_npz(ckpt_path))

    assert restored.steps == ctrl.steps
    assert np.allclose(restored.act_greedy(obs), before_action, atol=1e-6)
    assert np.isclose(restored.value(obs), before_value, atol=1e-6)


def test_cbp_state_npz_preserves_layer_sequences(tmp_path: Path) -> None:
    env = JointReachEnv(n_tasks=1, config=JointReachConfig(n_joints=3, embed_dim=4))
    ctrl = _controller(env)
    ckpt_path = tmp_path / "alberta_cbp_policy.npz"

    snap = ctrl.state_dict()
    save_state_npz(ckpt_path, snap)
    loaded = load_state_npz(ckpt_path)

    for field in (
        "a_weights",
        "a_biases",
        "c_weights",
        "c_biases",
        "a_util",
        "a_age",
    ):
        assert isinstance(loaded[field], list)
        assert len(loaded[field]) == len(snap[field])
        for original, restored in zip(snap[field], loaded[field], strict=True):
            assert restored.shape == original.shape
            assert restored.dtype == original.dtype
            assert np.array_equal(restored, original)


def test_cbp_actor_update_scale_zero_freezes_actor_but_not_critic() -> None:
    env = JointReachEnv(n_tasks=1, config=JointReachConfig(n_joints=3, embed_dim=4))
    ctrl = _controller(env)
    obs, _ = env.reset(seed=0)
    ctrl.start(obs)
    before = ctrl.state_dict()

    ctrl.set_actor_update_scale(0.0)
    ctrl.observe(1.0, obs, terminated=False)
    after = ctrl.state_dict()

    for field in ("a_weights", "a_biases", "mean_w", "mean_b", "log_sigma", "a_util", "a_age"):
        original = before[field]
        updated = after[field]
        if isinstance(original, list):
            assert all(
                np.array_equal(left, right)
                for left, right in zip(original, updated, strict=True)
            )
        else:
            assert np.array_equal(original, updated)
    assert any(
        not np.array_equal(left, right)
        for left, right in zip(before["c_weights"], after["c_weights"], strict=True)
    ) or not np.array_equal(before["critic_b"], after["critic_b"])


def test_low_authority_actor_credit_does_not_saturate_mean() -> None:
    ctrl = AlbertaCBPController(
        CBPControllerConfig(
            obs_dim=8,
            action_dim=4,
            hidden_sizes=(16,),
            gamma=0.97,
            actor_step_size=1e-3,
            critic_step_size=1e-2,
            log_sigma_init=-4.0,
            normalize=True,
            obgd_kappa=2.0,
            seed=15,
        )
    )
    rng = np.random.default_rng(0)
    obs = rng.normal(size=8).astype(np.float32)

    ctrl.start(obs)
    ctrl.set_actor_update_scale(0.04)
    for _ in range(1000):
        obs = (obs + 0.01 * rng.normal(size=8)).astype(np.float32)
        ctrl.observe(-5.0, obs, terminated=False)

    assert float(np.max(np.abs(ctrl.act_greedy(obs)))) < 0.5
