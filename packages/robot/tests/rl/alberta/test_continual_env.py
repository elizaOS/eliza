"""JointReach continual-learning env contract tests."""

from __future__ import annotations

import numpy as np

from eliza_robot.rl.alberta.continual_env import JointReachConfig, JointReachEnv


def test_spaces_and_obs_layout():
    cfg = JointReachConfig(n_joints=4, embed_dim=8)
    env = JointReachEnv(n_tasks=3, config=cfg)
    assert env.action_space.shape == (4,)
    # obs = q(4) + qd(4) + embedding(8)
    assert env.observation_space.shape == (16,)
    obs, info = env.reset(seed=0)
    assert obs.shape == (16,)
    assert "task_id" in info


def test_task_pinning_is_deterministic():
    env = JointReachEnv(n_tasks=4, config=JointReachConfig())
    env.set_task(2)
    ids = {env.reset(seed=s)[1]["task_id"] for s in range(10)}
    assert ids == {2}
    env.clear_forced_task()


def test_embedding_channel_identifies_task():
    # Different tasks must present distinguishable embedding channels, otherwise
    # the continual benchmark would confound capacity with forgetting.
    cfg = JointReachConfig(n_joints=3, embed_dim=8)
    env = JointReachEnv(n_tasks=4, config=cfg)
    embeds = []
    for t in range(4):
        env.set_task(t)
        obs, _ = env.reset(seed=0)
        embeds.append(obs[2 * cfg.n_joints :])
    for i in range(4):
        for j in range(i + 1, 4):
            assert np.linalg.norm(embeds[i] - embeds[j]) > 0.5


def test_reward_peaks_at_target():
    cfg = JointReachConfig(n_joints=2, embed_dim=4, control_penalty=0.0)
    env = JointReachEnv(n_tasks=1, config=cfg)
    env.set_task(0)
    env.reset(seed=0)
    # Drive straight at the target: reward should be near its max (exp(0)=1).
    target = env.target.copy()
    best = -1e9
    for _ in range(cfg.episode_steps):
        err = target - env._q
        action = np.clip(err / (cfg.action_scale * cfg.dt), -1.0, 1.0)
        _, reward, _, trunc, info = env.step(action)
        best = max(best, reward)
        if trunc:
            break
    assert best > 0.9
    assert info["dist"] < 0.1
