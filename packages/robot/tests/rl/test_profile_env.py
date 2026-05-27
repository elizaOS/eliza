"""Smoke tests for the profile-driven text-conditioned env.

One env class for every supported robot. Verifies reset+step round-trip
produces the documented observation and action shapes, and that the
selected tasks come from the curriculum.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from eliza_robot.rl.text_conditioned.profile_env import (
    ProfileEnvConfig,
    _contact_cadence_reward,
    _foot_clearance_reward,
    _stance_contact_reward,
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
    assert info["init_state"] == "stand"
    assert np.isfinite(info["init_torso_z"])
    assert np.isfinite(info["init_upright_proj"])
    # proprio = gyro+grav+cmd+root_linvel+foot telemetry+3*action_dim, plus text.
    expected = 20 + 3 * env.action_space.shape[0] + 32
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
    assert "left_foot_contact" in info
    assert "right_foot_slip_m_s" in info
    assert "gait_phase" in info
    assert "success_predicate_now" in info
    assert "success_bounds_violated" in info
    assert "success_bound_violation" in info
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


@pytest.mark.parametrize("profile_id", SUPPORTED)
def test_profile_env_resolves_foot_contact_geoms(profile_id: str) -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(profile_id, config=_smoke_config())
    env.reset(seed=0)

    assert env._floor_geom_ids.size >= 1  # noqa: SLF001
    assert env._foot_geom_ids["left"].size >= 1  # noqa: SLF001
    assert env._foot_geom_ids["right"].size >= 1  # noqa: SLF001
    assert env._last_foot_telemetry.shape == (8,)  # noqa: SLF001


def test_profile_env_unknown_profile_raises() -> None:
    pytest.importorskip("mujoco")
    with pytest.raises(FileNotFoundError):
        make_text_conditioned_env("does-not-exist")


def test_profile_env_rejects_unsupported_head_task_features() -> None:
    pytest.importorskip("mujoco")
    with pytest.raises(ValueError, match="unsupported task features"):
        make_text_conditioned_env(
            "hiwonder-ainex",
            config=ProfileEnvConfig(
                include_tasks=("look_up",),
                exclude_tasks=(),
                episode_steps=4,
                pca_dim=32,
            ),
        )


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


@pytest.mark.parametrize("profile_id", SUPPORTED)
def test_profile_env_prone_reset_contract(profile_id: str) -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        profile_id,
        config=ProfileEnvConfig(
            tier_subset=(2,),
            include_tasks=("get_up",),
            exclude_tasks=(),
            episode_steps=4,
            pca_dim=32,
        ),
    )

    _, info = env.reset(seed=0)

    assert info["task_id"] == "get_up"
    assert info["init_state"] == "prone"
    assert info["init_torso_z"] < 0.5 * info["stand_height_m"]
    assert info["init_upright_proj"] < 0.5


def test_turn_reward_uses_yaw_track_weight() -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("turn_left",),
            exclude_tasks=(),
            episode_steps=4,
            pca_dim=32,
        ),
    )
    env.reset(seed=0)
    pose = env._root_pose_summary()  # noqa: SLF001
    action = np.zeros(env.action_space.shape, dtype=np.float32)
    root_v = env._root_qvel_idx  # noqa: SLF001

    env._data.qvel[root_v + 5] = 0.6  # noqa: SLF001
    tracked = env._reward(action, pose=pose, fell=False)  # noqa: SLF001
    env._data.qvel[root_v + 5] = -0.6  # noqa: SLF001
    wrong_way = env._reward(action, pose=pose, fell=False)  # noqa: SLF001

    assert tracked > wrong_way + 3.0


def test_walk_reward_does_not_make_standstill_near_optimal() -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=4,
            pca_dim=32,
        ),
    )
    env.reset(seed=0)
    pose = env._root_pose_summary()  # noqa: SLF001
    action = np.zeros(env.action_space.shape, dtype=np.float32)
    root_v = env._root_qvel_idx  # noqa: SLF001

    env._data.qvel[root_v] = 0.10  # noqa: SLF001
    tracked = env._reward(action, pose=pose, fell=False)  # noqa: SLF001
    env._data.qvel[root_v] = 0.0  # noqa: SLF001
    standstill = env._reward(action, pose=pose, fell=False)  # noqa: SLF001

    assert tracked > standstill + 4.0


def test_walk_reward_uses_contact_cadence_and_slip_terms() -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=4,
            pca_dim=32,
        ),
    )
    env.reset(seed=0)
    pose = env._root_pose_summary()  # noqa: SLF001
    action = np.zeros(env.action_space.shape, dtype=np.float32)
    env._gait_phase = np.pi / 2.0  # noqa: SLF001

    env._last_foot_telemetry = np.array(  # noqa: SLF001
        [1.0, 0.0, 0.02, 0.03, 0.0, 0.0, 1.0, 0.0],
        dtype=np.float32,
    )
    matched = env._reward(action, pose=pose, fell=False)  # noqa: SLF001
    env._last_foot_telemetry = np.array(  # noqa: SLF001
        [0.0, 1.0, 0.02, 0.03, 0.4, 0.3, 1.0, 0.0],
        dtype=np.float32,
    )
    mismatched_slipping = env._reward(action, pose=pose, fell=False)  # noqa: SLF001

    assert matched > mismatched_slipping + 0.5


def test_contact_cadence_reward_prefers_alternating_stance() -> None:
    assert _contact_cadence_reward(np.array([1.0, 0.0]), np.pi / 2.0) == pytest.approx(1.0)
    assert _contact_cadence_reward(np.array([0.0, 1.0]), np.pi / 2.0) == pytest.approx(0.0)
    assert _contact_cadence_reward(np.array([0.0, 1.0]), 3.0 * np.pi / 2.0) == pytest.approx(1.0)
    assert _contact_cadence_reward(np.array([0.0, 0.0]), np.pi / 2.0) == pytest.approx(0.0)


def test_contact_rewards_require_stance_and_swing_clearance() -> None:
    contacts = np.array([1.0, 0.0], dtype=np.float32)
    dragging = np.array([0.02, 0.02], dtype=np.float32)
    clearing = np.array([0.02, 0.08], dtype=np.float32)

    assert _stance_contact_reward(contacts, np.pi / 2.0) == pytest.approx(1.0)
    assert _stance_contact_reward(np.array([0.0, 0.0]), np.pi / 2.0) == pytest.approx(0.0)
    assert _foot_clearance_reward(clearing, contacts, np.pi / 2.0, 0.08) > 0.9
    assert _foot_clearance_reward(dragging, contacts, np.pi / 2.0, 0.08) == pytest.approx(0.0)


def test_profile_reward_penalizes_declared_drift_bounds() -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("sidestep_left",),
            exclude_tasks=(),
            episode_steps=4,
            pca_dim=32,
        ),
    )
    env.reset(seed=0)
    action = np.zeros(env.action_space.shape, dtype=np.float32)
    base_pose = env._root_pose_summary()  # noqa: SLF001
    stable_pose = dict(base_pose)
    drift_pose = dict(base_pose)
    drift_pose["x"] = env._episode_start_x + 0.45  # noqa: SLF001
    drift_pose["yaw"] = env._episode_start_yaw + 0.8  # noqa: SLF001

    stable = env._reward(action, pose=stable_pose, fell=False)  # noqa: SLF001
    drifted = env._reward(action, pose=drift_pose, fell=False)  # noqa: SLF001

    assert drifted < stable


def test_walk_reward_penalizes_dragging_and_unsupported_feet() -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=4,
            pca_dim=32,
        ),
    )
    env.reset(seed=0)
    action = np.zeros(env.action_space.shape, dtype=np.float32)
    pose = env._root_pose_summary()  # noqa: SLF001
    root_v = env._root_qvel_idx  # noqa: SLF001
    env._data.qvel[root_v] = 0.10  # noqa: SLF001
    env._current_foot_xy = lambda: np.array(  # type: ignore[method-assign]  # noqa: SLF001
        [[0.0, 0.05], [0.0, -0.05]],
        dtype=np.float32,
    )

    env._gait_phase = np.pi / 2.0  # noqa: SLF001
    env._last_foot_telemetry = np.array(  # noqa: SLF001
        [1.0, 0.0, 0.02, 0.08, 0.0, 0.0, 1.0, 0.0],
        dtype=np.float32,
    )
    clearing = env._reward(action, pose=pose, fell=False)  # noqa: SLF001
    env._last_foot_telemetry = np.array(  # noqa: SLF001
        [1.0, 0.0, 0.02, 0.02, 0.0, 0.0, 1.0, 0.0],
        dtype=np.float32,
    )
    dragging = env._reward(action, pose=pose, fell=False)  # noqa: SLF001
    env._last_foot_telemetry = np.array(  # noqa: SLF001
        [0.0, 0.0, 0.02, 0.08, 0.0, 0.0, 1.0, 0.0],
        dtype=np.float32,
    )
    no_support = env._reward(action, pose=pose, fell=False)  # noqa: SLF001

    assert clearing > dragging + 0.3
    assert clearing > no_support + 0.7


def test_walk_reward_penalizes_foot_spacing_and_self_collision() -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=4,
            pca_dim=32,
        ),
    )
    env.reset(seed=0)
    action = np.zeros(env.action_space.shape, dtype=np.float32)
    pose = env._root_pose_summary()  # noqa: SLF001
    env._gait_phase = np.pi / 2.0  # noqa: SLF001
    env._last_foot_telemetry = np.array(  # noqa: SLF001
        [1.0, 0.0, 0.02, 0.08, 0.0, 0.0, 1.0, 0.0],
        dtype=np.float32,
    )
    env._self_collision_count = lambda: 0  # type: ignore[method-assign]  # noqa: SLF001
    env._current_foot_xy = lambda: np.array(  # type: ignore[method-assign]  # noqa: SLF001
        [[0.0, 0.05], [0.0, -0.05]],
        dtype=np.float32,
    )
    stable = env._reward(action, pose=pose, fell=False)  # noqa: SLF001
    env._current_foot_xy = lambda: np.array(  # type: ignore[method-assign]  # noqa: SLF001
        [[0.0, -0.01], [0.0, 0.01]],
        dtype=np.float32,
    )
    crossed = env._reward(action, pose=pose, fell=False)  # noqa: SLF001
    env._self_collision_count = lambda: 2  # type: ignore[method-assign]  # noqa: SLF001
    colliding = env._reward(action, pose=pose, fell=False)  # noqa: SLF001

    assert crossed < stable - 1.0
    assert colliding < crossed - 3.0


def test_sit_down_reward_penalizes_declared_xy_drift_bounds() -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("sit_down",),
            exclude_tasks=(),
            episode_steps=4,
            pca_dim=32,
        ),
    )
    env.reset(seed=0)
    action = np.zeros(env.action_space.shape, dtype=np.float32)
    base_pose = env._root_pose_summary()  # noqa: SLF001
    seated_pose = dict(base_pose)
    seated_pose["z"] = 0.16
    seated_pose["x"] = env._episode_start_x + 0.02  # noqa: SLF001
    seated_pose["y"] = env._episode_start_y + 0.01  # noqa: SLF001
    drift_pose = dict(seated_pose)
    drift_pose["x"] = env._episode_start_x + 0.35  # noqa: SLF001
    drift_pose["y"] = env._episode_start_y + 0.35  # noqa: SLF001

    seated = env._reward(action, pose=seated_pose, fell=False)  # noqa: SLF001
    drifted = env._reward(action, pose=drift_pose, fell=False)  # noqa: SLF001

    assert drifted < seated - 10.0


def test_walk_reward_bound_violation_beats_perfect_velocity_tracking() -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=4,
            pca_dim=32,
        ),
    )
    env.reset(seed=0)
    action = np.zeros(env.action_space.shape, dtype=np.float32)
    root_v = env._root_qvel_idx  # noqa: SLF001
    base_pose = env._root_pose_summary()  # noqa: SLF001
    valid_pose = dict(base_pose)
    valid_pose["x"] = env._episode_start_x + 0.35  # noqa: SLF001
    valid_pose["y"] = env._episode_start_y  # noqa: SLF001
    valid_pose["yaw"] = env._episode_start_yaw  # noqa: SLF001
    drift_pose = dict(valid_pose)
    drift_pose["y"] = env._episode_start_y + 0.55  # noqa: SLF001

    env._data.qvel[root_v] = 0.08  # noqa: SLF001
    valid_slightly_slow = env._reward(action, pose=valid_pose, fell=False)  # noqa: SLF001
    env._data.qvel[root_v] = 0.10  # noqa: SLF001
    drifted_perfect_tracking = env._reward(action, pose=drift_pose, fell=False)  # noqa: SLF001

    assert drifted_perfect_tracking < valid_slightly_slow


def test_walk_reward_success_bonus_requires_height_and_forward_motion() -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=4,
            pca_dim=32,
        ),
    )
    env.reset(seed=0)
    action = np.zeros(env.action_space.shape, dtype=np.float32)
    root_v = env._root_qvel_idx  # noqa: SLF001
    env._data.qvel[root_v] = 0.10  # noqa: SLF001

    base_pose = env._root_pose_summary()  # noqa: SLF001
    success_pose = dict(base_pose)
    success_pose["x"] = env._episode_start_x + 0.35  # noqa: SLF001
    success_pose["y"] = env._episode_start_y  # noqa: SLF001
    success_pose["yaw"] = env._episode_start_yaw  # noqa: SLF001
    low_pose = dict(success_pose)
    low_pose["z"] = 0.05
    standstill_pose = dict(base_pose)
    standstill_pose["x"] = env._episode_start_x  # noqa: SLF001
    standstill_pose["y"] = env._episode_start_y  # noqa: SLF001
    standstill_pose["yaw"] = env._episode_start_yaw  # noqa: SLF001

    success_reward = env._reward(action, pose=success_pose, fell=False)  # noqa: SLF001
    low_reward = env._reward(action, pose=low_pose, fell=False)  # noqa: SLF001
    standstill_reward = env._reward(action, pose=standstill_pose, fell=False)  # noqa: SLF001

    assert env._immediate_success_predicate_holds(success_pose) is True  # noqa: SLF001
    assert env._immediate_success_predicate_holds(low_pose) is False  # noqa: SLF001
    assert env._immediate_success_predicate_holds(standstill_pose) is False  # noqa: SLF001
    assert env._success_bound_violation_score(0.35, 0.0, 0.0) == 0.0  # noqa: SLF001
    assert env._success_bound_violation_score(0.35, 0.55, 0.0) > 0.0  # noqa: SLF001
    assert success_reward > low_reward + 8.0
    assert success_reward > standstill_reward + 6.0


def test_stand_up_reward_success_bonus_requires_height_delta() -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("stand_up",),
            exclude_tasks=(),
            episode_steps=4,
            pca_dim=32,
        ),
    )
    env.reset(seed=0)
    action = np.zeros(env.action_space.shape, dtype=np.float32)
    no_delta_pose = env._root_pose_summary()  # noqa: SLF001
    no_delta_pose["z"] = env._stand_height_m * 0.91  # noqa: SLF001
    stood_pose = dict(no_delta_pose)
    stood_pose["z"] = env._episode_start_torso_z + env._stand_height_m * 0.10  # noqa: SLF001

    assert env._immediate_success_predicate_holds(no_delta_pose) is False  # noqa: SLF001
    assert env._immediate_success_predicate_holds(stood_pose) is True  # noqa: SLF001
    assert env._reward(action, pose=stood_pose, fell=False) > env._reward(  # noqa: SLF001
        action,
        pose=no_delta_pose,
        fell=False,
    ) + 6.0


def test_profile_env_reports_fall_done_reason_and_stronger_penalty() -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=4,
            pca_dim=32,
        ),
    )
    env.reset(seed=0)
    action = np.zeros(env.action_space.shape, dtype=np.float32)
    pose = env._root_pose_summary()  # noqa: SLF001
    fallen_pose = dict(pose)
    fallen_pose["z"] = 0.01

    standing = env._reward(action, pose=pose, fell=False)  # noqa: SLF001
    fallen = env._reward(action, pose=fallen_pose, fell=True)  # noqa: SLF001

    assert fallen < standing - 20.0

    env._data.qpos[env._root_qpos_idx + 2] = 0.01  # noqa: SLF001
    _, _, terminated, truncated, info = env.step(action)
    assert terminated is True
    assert truncated is False
    assert info["done_reason"] == "fall"


def test_profile_env_tilt_fall_matches_goal_checker_thresholds() -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=4,
            pca_dim=32,
        ),
    )
    env.reset(seed=0)
    root = env._root_qpos_idx  # noqa: SLF001
    pitch = 0.7
    env._data.qpos[root + 2] = env._stand_height_m  # noqa: SLF001
    env._data.qpos[root + 3: root + 7] = np.array(
        [math.cos(pitch / 2.0), 0.0, math.sin(pitch / 2.0), 0.0],
        dtype=env._data.qpos.dtype,  # noqa: SLF001
    )

    _, _, terminated, _, info = env.step(np.zeros(env.action_space.shape, dtype=np.float32))

    assert terminated is True
    assert info["done_reason"] == "fall"
    assert abs(info["imu_pitch"]) > 0.6
