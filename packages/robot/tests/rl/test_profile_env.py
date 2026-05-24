"""Smoke tests for the profile-driven text-conditioned env.

One env class for every supported robot. Verifies reset+step round-trip
produces the documented observation and action shapes, and that the
selected tasks come from the curriculum.
"""

from __future__ import annotations

import numpy as np
import pytest

from eliza_robot.rl.text_conditioned.profile_env import (
    ProfileEnvConfig,
    make_text_conditioned_env,
)

SUPPORTED = ("hiwonder-ainex", "asimov-1", "unitree-g1", "unitree-h1", "unitree-r1")


def _smoke_config(**overrides) -> ProfileEnvConfig:
    base = dict(
        include_tasks=("walk_forward", "turn_left"),
        exclude_tasks=(),
        episode_steps=4,
        pca_dim=32,
    )
    base.update(overrides)
    return ProfileEnvConfig(**base)


@pytest.mark.parametrize("profile_id", SUPPORTED)
def test_profile_env_reset_returns_obs(profile_id: str) -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(profile_id, config=_smoke_config())
    obs, info = env.reset(seed=0)
    assert obs.shape == env.observation_space.shape
    assert obs.dtype == np.float32
    assert info["task_id"] in {"walk_forward", "turn_left"}
    # proprio = gyro(3)+grav(3)+cmd(3)+3*action_dim, plus text(pca_dim=32)
    expected = 9 + 3 * env.action_space.shape[0] + 32
    assert obs.shape == (expected,), (
        f"{profile_id} obs={obs.shape} expected=({expected},)"
    )


@pytest.mark.parametrize("profile_id", SUPPORTED)
def test_profile_env_step_runs(profile_id: str) -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(profile_id, config=_smoke_config())
    env.reset(seed=0)
    obs, reward, terminated, truncated, info = env.step(
        np.zeros(env.action_space.shape, dtype=np.float32)
    )
    assert obs.shape == env.observation_space.shape
    assert np.isfinite(reward)
    assert isinstance(terminated, bool)
    assert isinstance(truncated, bool)
    assert info["task_id"] in {"walk_forward", "turn_left"}
    assert info["torso_z"] > env._fall_z_threshold  # noqa: SLF001
    assert info["upright_proj"] > 0.0
    assert not terminated


@pytest.mark.parametrize("profile_id", SUPPORTED)
def test_profile_env_action_dim_matches_leg_joints(profile_id: str) -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(profile_id, config=_smoke_config())
    from eliza_robot.profiles.schema import load_profile

    profile = load_profile(profile_id)
    leg_count = sum(1 for j in profile.kinematics.joints if j.group == "LEG")
    assert env.action_space.shape[0] == leg_count


@pytest.mark.parametrize("profile_id", SUPPORTED)
def test_profile_env_resolves_action_actuators(profile_id: str) -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(profile_id, config=_smoke_config())
    env.reset(seed=0)
    missing = [
        joint.name
        for joint, actuator_id in zip(
            env._action_joints,  # noqa: SLF001
            env._joint_actuator_idx,  # noqa: SLF001
            strict=True,
        )
        if actuator_id < 0
    ]
    assert missing == []


def test_profile_env_unknown_profile_raises() -> None:
    pytest.importorskip("mujoco")
    with pytest.raises(FileNotFoundError):
        make_text_conditioned_env("does-not-exist")


def test_profile_env_truncates_at_episode_steps() -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env("unitree-h1", config=_smoke_config(episode_steps=2))
    env.reset(seed=0)
    truncated = False
    for _ in range(5):
        _, _, _, truncated, _ = env.step(
            np.zeros(env.action_space.shape, dtype=np.float32)
        )
        if truncated:
            break
    assert truncated, "env did not truncate at episode_steps=2"
