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
    assert np.isfinite(info["init_tracked_z"])
    assert info["tracked_body_name"]
    assert np.isfinite(info["init_upright_proj"])
    assert np.isfinite(info["min_robot_geom_floor_clearance_m"])
    assert info["floor_penetration_tolerance_m"] > 0.0
    assert info["below_floor_robot_geom_count"] == 0
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
    assert "foot_contact_switch_count" in info
    assert "right_foot_slip_m_s" in info
    assert "gait_phase" in info
    assert "success_predicate_now" in info
    assert "success_bounds_violated" in info
    assert "success_bound_violation" in info
    assert "min_robot_geom_floor_clearance_m" in info
    assert "below_floor_robot_geom_count" in info
    assert "worst_below_floor_robot_geom" in info
    assert "floor_penetration_tolerance_m" in info
    assert info["tracked_body_name"]
    assert np.isfinite(info["tracked_z"])
    assert np.isfinite(info["tracked_delta_x"])
    assert np.isfinite(info["tracked_delta_y"])
    assert np.isfinite(info["tracked_delta_z"])
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


def test_hiwonder_cpu_mjcf_uses_primitive_foot_contacts_only() -> None:
    mujoco = pytest.importorskip("mujoco")
    env = make_text_conditioned_env("hiwonder-ainex", config=_smoke_config())
    env.reset(seed=0)

    def geom_id(name: str) -> int:
        return mujoco.mj_name2id(env._model, mujoco.mjtObj.mjOBJ_GEOM, name)  # noqa: SLF001

    for name in ("body",):
        gid = geom_id(name)
        assert gid >= 0
        assert int(env._model.geom_contype[gid]) == 0  # noqa: SLF001
        assert int(env._model.geom_conaffinity[gid]) == 0  # noqa: SLF001

    for name in ("l_foot1", "l_foot2", "r_foot1", "r_foot2"):
        gid = geom_id(name)
        assert gid >= 0
        assert int(env._model.geom_contype[gid]) == 1  # noqa: SLF001
        assert int(env._model.geom_conaffinity[gid]) == 1  # noqa: SLF001


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


@pytest.mark.parametrize("profile_id", SUPPORTED)
def test_stand_up_reset_starts_from_contact_valid_crouch(profile_id: str) -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        profile_id,
        config=ProfileEnvConfig(
            include_tasks=("stand_up",),
            exclude_tasks=(),
            episode_steps=4,
            pca_dim=32,
        ),
    )

    _, info = env.reset(seed=0)
    assert info["task_id"] == "stand_up"
    assert info["init_state"] == "crouch"
    max_init_ratio = 0.75 if profile_id == "hiwonder-ainex" else 0.96
    assert info["init_torso_z"] <= max_init_ratio * info["stand_height_m"]
    if profile_id == "hiwonder-ainex":
        assert info["init_torso_z"] <= 0.75 * info["stand_height_m"]

    _, _, terminated, _, step_info = env.step(
        np.zeros(env.action_space.shape, dtype=np.float32)
    )
    assert terminated is False
    assert step_info["done_reason"] is None
    support = env._foot_floor_support_state()  # noqa: SLF001
    assert step_info["left_foot_contact"] is True or support["left"]
    assert step_info["right_foot_contact"] is True or support["right"]
    assert step_info["fall_threshold"] <= step_info["init_torso_z"]


def test_hiwonder_stand_up_floor_placement_uses_foot_extents() -> None:
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

    _, info = env.reset(seed=0)
    foot_min_z = env._current_foot_aabb_min_z()  # noqa: SLF001
    finite_foot_min_z = foot_min_z[np.isfinite(foot_min_z)]

    assert finite_foot_min_z.size == 2
    assert np.min(finite_foot_min_z) >= env._floor_height_m() - 1e-4  # noqa: SLF001
    assert info["below_floor_robot_geom_count"] == 0


def test_profile_env_detects_deliberate_below_floor_geometry() -> None:
    mujoco = pytest.importorskip("mujoco")
    env = make_text_conditioned_env("hiwonder-ainex", config=_smoke_config())
    env.reset(seed=0)
    tolerance = float(
        env._robot_geometry_floor_clearance_summary()[  # noqa: SLF001
            "floor_penetration_tolerance_m"
        ]
    )

    env._data.qpos[env._root_qpos_idx + 2] -= tolerance + 0.03  # noqa: SLF001
    mujoco.mj_forward(env._model, env._data)  # noqa: SLF001
    summary = env._robot_geometry_floor_clearance_summary()  # noqa: SLF001

    assert summary["below_floor_robot_geom_count"] > 0
    assert summary["worst_below_floor_robot_geom"]


@pytest.mark.parametrize("profile_id", SUPPORTED)
def test_stand_up_zero_action_rollout_keeps_collision_feet_above_floor(
    profile_id: str,
) -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        profile_id,
        config=ProfileEnvConfig(
            include_tasks=("stand_up",),
            exclude_tasks=(),
            episode_steps=12,
            pca_dim=32,
        ),
    )
    env.reset(seed=0)

    for _ in range(10):
        _, _, terminated, truncated, info = env.step(
            np.zeros(env.action_space.shape, dtype=np.float32)
        )
        summary = env._robot_geometry_floor_clearance_summary()  # noqa: SLF001
        assert summary["below_floor_robot_geom_count"] == 0
        assert summary["min_robot_geom_floor_clearance_m"] >= -summary[
            "floor_penetration_tolerance_m"
        ]
        if terminated or truncated:
            assert info["done_reason"] is not None
            break


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


def test_walk_reward_does_not_make_tracked_standstill_near_optimal(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
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
    monkeypatch.setattr(
        env,
        "_tracked_pose_summary",
        lambda pose: {"x": pose["x"], "y": pose["y"], "z": pose["z"]},
    )
    pose = env._root_pose_summary()  # noqa: SLF001
    moving_pose = dict(pose)
    moving_pose["x"] = env._episode_start_x + 0.12  # noqa: SLF001
    action = np.zeros(env.action_space.shape, dtype=np.float32)
    root_v = env._root_qvel_idx  # noqa: SLF001
    env._foot_contact_switch_count = 2  # noqa: SLF001

    env._data.qvel[root_v] = 0.10  # noqa: SLF001
    tracked = env._reward(action, pose=moving_pose, fell=False)  # noqa: SLF001
    env._data.qvel[root_v] = 0.0  # noqa: SLF001
    standstill = env._reward(action, pose=pose, fell=False)  # noqa: SLF001

    assert tracked > standstill + 2.0


def test_walk_reward_progress_uses_tracked_body_not_root_only() -> None:
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
    env._foot_contact_switch_count = 2  # noqa: SLF001

    env._tracked_pose_summary = lambda _pose: {  # type: ignore[method-assign]  # noqa: SLF001
        "x": env._episode_start_tracked_x + 0.3,  # noqa: SLF001
        "y": env._episode_start_tracked_y,  # noqa: SLF001
        "z": env._episode_start_tracked_z,  # noqa: SLF001
    }
    tracked_progress = env._reward(action, pose=pose, fell=False)  # noqa: SLF001
    env._tracked_pose_summary = lambda _pose: {  # type: ignore[method-assign]  # noqa: SLF001
        "x": env._episode_start_tracked_x,  # noqa: SLF001
        "y": env._episode_start_tracked_y,  # noqa: SLF001
        "z": env._episode_start_tracked_z,  # noqa: SLF001
    }
    no_progress = env._reward(action, pose=pose, fell=False)  # noqa: SLF001

    assert tracked_progress > no_progress + 3.0


def test_hiwonder_locomotion_tracks_stable_body_not_head() -> None:
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
    _, info = env.reset(seed=0)

    assert info["tracked_body_name"] == "body_link"
    assert env._tracked_body_name == "body_link"  # noqa: SLF001


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


def test_walk_reward_penalizes_dragging_and_unsupported_feet(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
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
    monkeypatch.setattr(
        env,
        "_tracked_pose_summary",
        lambda pose: {"x": pose["x"], "y": pose["y"], "z": pose["z"]},
    )
    action = np.zeros(env.action_space.shape, dtype=np.float32)
    pose = env._root_pose_summary()  # noqa: SLF001
    pose["x"] = env._episode_start_x + 0.12  # noqa: SLF001
    root_v = env._root_qvel_idx  # noqa: SLF001
    env._data.qvel[root_v] = 0.10  # noqa: SLF001
    env._foot_contact_switch_count = 2  # noqa: SLF001
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


def test_sit_down_reward_penalizes_declared_xy_drift_bounds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
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
    env._foot_contact_switch_count = 2  # noqa: SLF001
    env._max_swing_foot_clearance_m = 0.03  # noqa: SLF001
    env._max_foot_slip_m_s = 0.02  # noqa: SLF001
    env._last_foot_telemetry = np.array(  # noqa: SLF001
        [1.0, 1.0, 0.0, 0.0, 0.02, 0.02, 0.0, 0.0],
        dtype=np.float32,
    )
    monkeypatch.setattr(
        env,
        "_tracked_pose_summary",
        lambda pose: {"x": pose["x"], "y": pose["y"], "z": pose["z"]},
    )
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


def test_walk_reward_bound_violation_beats_perfect_velocity_tracking(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
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
    env._foot_contact_switch_count = 2  # noqa: SLF001
    env._max_swing_foot_clearance_m = 0.03  # noqa: SLF001
    env._last_foot_telemetry = np.array(  # noqa: SLF001
        [1.0, 1.0, 0.0, 0.0, 0.02, 0.02, 0.0, 0.0],
        dtype=np.float32,
    )
    env._max_foot_slip_m_s = 0.02  # noqa: SLF001
    monkeypatch.setattr(
        env,
        "_tracked_pose_summary",
        lambda pose: {"x": pose["x"], "y": pose["y"], "z": pose["z"]},
    )
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


def test_walk_reward_success_bonus_requires_height_and_forward_motion(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
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
    env._foot_contact_switch_count = 2  # noqa: SLF001
    env._max_swing_foot_clearance_m = 0.03  # noqa: SLF001
    env._max_foot_slip_m_s = 0.02  # noqa: SLF001
    monkeypatch.setattr(
        env,
        "_tracked_pose_summary",
        lambda pose: {"x": pose["x"], "y": pose["y"], "z": pose["z"]},
    )
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


def test_walk_reward_prefers_stable_goal_hold_over_near_fall_lunge(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
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
    env._foot_contact_switch_count = 2  # noqa: SLF001
    env._max_swing_foot_clearance_m = 0.03  # noqa: SLF001
    env._max_foot_slip_m_s = 0.02  # noqa: SLF001
    env._last_foot_telemetry = np.array(  # noqa: SLF001
        [1.0, 1.0, 0.0, 0.0, 0.02, 0.02, 0.0, 0.0],
        dtype=np.float32,
    )
    monkeypatch.setattr(
        env,
        "_tracked_pose_summary",
        lambda pose: {"x": pose["x"], "y": pose["y"], "z": pose["z"]},
    )
    action = np.zeros(env.action_space.shape, dtype=np.float32)
    root_v = env._root_qvel_idx  # noqa: SLF001
    base_pose = env._root_pose_summary()  # noqa: SLF001
    stable_pose = dict(base_pose)
    stable_pose["x"] = env._episode_start_x + 0.35  # noqa: SLF001
    stable_pose["y"] = env._episode_start_y  # noqa: SLF001
    stable_pose["yaw"] = env._episode_start_yaw  # noqa: SLF001
    stable_pose["roll"] = 0.02
    stable_pose["pitch"] = 0.02
    near_fall_pose = dict(stable_pose)
    near_fall_pose["pitch"] = 0.55

    env._data.qvel[root_v] = 0.0  # noqa: SLF001
    stable_hold = env._reward(action, pose=stable_pose, fell=False)  # noqa: SLF001
    env._data.qvel[root_v] = 0.20  # noqa: SLF001
    near_fall_lunge = env._reward(action, pose=near_fall_pose, fell=False)  # noqa: SLF001

    assert env._immediate_success_predicate_holds(stable_pose) is True  # noqa: SLF001
    assert env._immediate_success_predicate_holds(near_fall_pose) is True  # noqa: SLF001
    assert stable_hold > near_fall_lunge + 2.0


def test_walk_reward_gates_progress_and_success_bonus_near_fall(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
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
    env._foot_contact_switch_count = 2  # noqa: SLF001
    env._max_swing_foot_clearance_m = 0.03  # noqa: SLF001
    env._max_foot_slip_m_s = 0.02  # noqa: SLF001
    monkeypatch.setattr(
        env,
        "_tracked_pose_summary",
        lambda pose: {"x": pose["x"], "y": pose["y"], "z": pose["z"]},
    )
    action = np.zeros(env.action_space.shape, dtype=np.float32)
    root_v = env._root_qvel_idx  # noqa: SLF001
    base_pose = env._root_pose_summary()  # noqa: SLF001
    stable_partial = dict(base_pose)
    stable_partial["x"] = env._episode_start_x + 0.18  # noqa: SLF001
    stable_partial["y"] = env._episode_start_y  # noqa: SLF001
    stable_partial["yaw"] = env._episode_start_yaw  # noqa: SLF001
    stable_partial["roll"] = 0.02
    stable_partial["pitch"] = 0.02
    near_fall_success = dict(stable_partial)
    near_fall_success["x"] = env._episode_start_x + 0.35  # noqa: SLF001
    near_fall_success["pitch"] = 0.55

    env._data.qvel[root_v] = 0.10  # noqa: SLF001
    stable_partial_reward = env._reward(action, pose=stable_partial, fell=False)  # noqa: SLF001
    env._data.qvel[root_v] = 0.20  # noqa: SLF001
    near_fall_reward = env._reward(action, pose=near_fall_success, fell=False)  # noqa: SLF001

    assert env._immediate_success_predicate_holds(stable_partial) is False  # noqa: SLF001
    assert env._immediate_success_predicate_holds(near_fall_success) is True  # noqa: SLF001
    assert stable_partial_reward > near_fall_reward


def test_walk_terminal_fall_penalty_scales_with_forward_progress(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
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
    env._foot_contact_switch_count = 2  # noqa: SLF001
    env._max_swing_foot_clearance_m = 0.03  # noqa: SLF001
    env._max_foot_slip_m_s = 0.02  # noqa: SLF001
    monkeypatch.setattr(
        env,
        "_tracked_pose_summary",
        lambda pose: {"x": pose["x"], "y": pose["y"], "z": pose["z"]},
    )
    action = np.zeros(env.action_space.shape, dtype=np.float32)
    base_pose = env._root_pose_summary()  # noqa: SLF001
    early_fall = dict(base_pose)
    early_fall["x"] = env._episode_start_x + 0.03  # noqa: SLF001
    early_fall["y"] = env._episode_start_y  # noqa: SLF001
    early_fall["yaw"] = env._episode_start_yaw  # noqa: SLF001
    late_fall = dict(early_fall)
    late_fall["x"] = env._episode_start_x + 0.27  # noqa: SLF001

    early_reward = env._reward(action, pose=early_fall, fell=True)  # noqa: SLF001
    early_penalty = env._last_reward_terms["fall_after_progress"]  # noqa: SLF001
    late_reward = env._reward(action, pose=late_fall, fell=True)  # noqa: SLF001
    late_penalty = env._last_reward_terms["fall_after_progress"]  # noqa: SLF001

    assert late_penalty < early_penalty
    assert late_reward < early_reward


def test_walk_near_goal_hold_penalty_targets_unstable_or_slipping_motion(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
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
    env._foot_contact_switch_count = 2  # noqa: SLF001
    env._max_swing_foot_clearance_m = 0.03  # noqa: SLF001
    env._last_foot_telemetry = np.array(  # noqa: SLF001
        [1.0, 1.0, 0.0, 0.0, 0.02, 0.02, 0.0, 0.0],
        dtype=np.float32,
    )
    monkeypatch.setattr(
        env,
        "_tracked_pose_summary",
        lambda pose: {"x": pose["x"], "y": pose["y"], "z": pose["z"]},
    )
    action = np.zeros(env.action_space.shape, dtype=np.float32)
    root_v = env._root_qvel_idx  # noqa: SLF001
    base_pose = env._root_pose_summary()  # noqa: SLF001
    stable_pose = dict(base_pose)
    stable_pose["x"] = env._episode_start_x + 0.29  # noqa: SLF001
    stable_pose["y"] = env._episode_start_y  # noqa: SLF001
    stable_pose["yaw"] = env._episode_start_yaw  # noqa: SLF001
    stable_pose["roll"] = 0.02
    stable_pose["pitch"] = 0.02
    unstable_pose = dict(stable_pose)
    unstable_pose["pitch"] = 0.55

    env._max_foot_slip_m_s = 0.02  # noqa: SLF001
    env._data.qvel[root_v] = 0.0  # noqa: SLF001
    stable_reward = env._reward(action, pose=stable_pose, fell=False)  # noqa: SLF001
    stable_instability = env._last_reward_terms["late_hold_instability"]  # noqa: SLF001

    env._max_foot_slip_m_s = 0.60  # noqa: SLF001
    env._data.qvel[root_v] = 0.20  # noqa: SLF001
    unstable_reward = env._reward(action, pose=unstable_pose, fell=False)  # noqa: SLF001

    assert stable_instability == pytest.approx(0.0)
    assert env._last_reward_terms["late_hold_instability"] < 0.0  # noqa: SLF001
    assert env._last_reward_terms["late_hold_speed"] < 0.0  # noqa: SLF001
    assert stable_reward > unstable_reward


def test_walk_near_goal_hold_penalty_does_not_suppress_early_exploration(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
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
    env._foot_contact_switch_count = 2  # noqa: SLF001
    env._max_swing_foot_clearance_m = 0.03  # noqa: SLF001
    env._max_foot_slip_m_s = 0.60  # noqa: SLF001
    monkeypatch.setattr(
        env,
        "_tracked_pose_summary",
        lambda pose: {"x": pose["x"], "y": pose["y"], "z": pose["z"]},
    )
    action = np.zeros(env.action_space.shape, dtype=np.float32)
    pose = env._root_pose_summary()  # noqa: SLF001
    pose["x"] = env._episode_start_x + 0.18  # noqa: SLF001
    pose["y"] = env._episode_start_y  # noqa: SLF001
    pose["yaw"] = env._episode_start_yaw  # noqa: SLF001
    pose["roll"] = 0.02
    pose["pitch"] = 0.55

    env._reward(action, pose=pose, fell=False)  # noqa: SLF001

    assert env._last_reward_terms["late_hold_instability"] == pytest.approx(0.0)  # noqa: SLF001
    assert env._last_reward_terms["late_hold_speed"] == pytest.approx(0.0)  # noqa: SLF001


def test_walk_goal_hold_reward_prefers_braking_in_verifier_corridor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
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
    env._foot_contact_switch_count = 2  # noqa: SLF001
    env._max_swing_foot_clearance_m = 0.03  # noqa: SLF001
    env._max_foot_slip_m_s = 0.02  # noqa: SLF001
    env._last_foot_telemetry = np.array(  # noqa: SLF001
        [1.0, 0.0, 0.0, 0.03, 0.02, 0.02, 0.0, 1.0],
        dtype=np.float32,
    )
    monkeypatch.setattr(
        env,
        "_tracked_pose_summary",
        lambda pose: {"x": pose["x"], "y": pose["y"], "z": pose["z"]},
    )
    action = np.zeros(env.action_space.shape, dtype=np.float32)
    pose = env._root_pose_summary()  # noqa: SLF001
    pose["x"] = env._episode_start_x + 0.31  # noqa: SLF001
    pose["y"] = env._episode_start_y  # noqa: SLF001
    pose["yaw"] = env._episode_start_yaw  # noqa: SLF001
    pose["roll"] = 0.02
    pose["pitch"] = 0.02
    root_v = env._root_qvel_idx  # noqa: SLF001

    env._data.qvel[root_v] = 0.0  # noqa: SLF001
    slow_reward = env._reward(action, pose=pose, fell=False)  # noqa: SLF001
    slow_brake = env._last_reward_terms["goal_hold_brake"]  # noqa: SLF001

    env._data.qvel[root_v] = 0.35  # noqa: SLF001
    fast_reward = env._reward(action, pose=pose, fell=False)  # noqa: SLF001

    assert env._last_reward_terms["goal_hold_brake"] < slow_brake  # noqa: SLF001
    assert env._last_reward_terms["goal_hold_support"] > 0.0  # noqa: SLF001
    assert slow_reward > fast_reward


def test_walk_goal_hold_reward_penalizes_near_goal_slip(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
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
    env._foot_contact_switch_count = 2  # noqa: SLF001
    env._max_swing_foot_clearance_m = 0.03  # noqa: SLF001
    monkeypatch.setattr(
        env,
        "_tracked_pose_summary",
        lambda pose: {"x": pose["x"], "y": pose["y"], "z": pose["z"]},
    )
    action = np.zeros(env.action_space.shape, dtype=np.float32)
    pose = env._root_pose_summary()  # noqa: SLF001
    pose["x"] = env._episode_start_x + 0.31  # noqa: SLF001
    pose["y"] = env._episode_start_y  # noqa: SLF001
    pose["yaw"] = env._episode_start_yaw  # noqa: SLF001
    pose["roll"] = 0.02
    pose["pitch"] = 0.02

    env._max_foot_slip_m_s = 0.02  # noqa: SLF001
    clean_reward = env._reward(action, pose=pose, fell=False)  # noqa: SLF001

    env._max_foot_slip_m_s = 0.60  # noqa: SLF001
    slipping_reward = env._reward(action, pose=pose, fell=False)  # noqa: SLF001

    assert env._last_reward_terms["goal_hold_slip"] < 0.0  # noqa: SLF001
    assert slipping_reward < clean_reward


def test_walk_reward_downscales_progress_when_support_contract_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
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
    monkeypatch.setattr(
        env,
        "_tracked_pose_summary",
        lambda pose: {"x": pose["x"], "y": pose["y"], "z": pose["z"]},
    )
    monkeypatch.setattr(env, "_self_collision_count", lambda: 0)
    action = np.zeros(env.action_space.shape, dtype=np.float32)
    pose = env._root_pose_summary()  # noqa: SLF001
    pose["x"] = env._episode_start_x + 0.18  # noqa: SLF001
    pose["y"] = env._episode_start_y  # noqa: SLF001
    pose["yaw"] = env._episode_start_yaw  # noqa: SLF001
    env._foot_contact_switch_count = 2  # noqa: SLF001
    env._max_swing_foot_clearance_m = 0.03  # noqa: SLF001
    env._last_foot_telemetry = np.array(  # noqa: SLF001
        [1.0, 0.0, 0.0, 0.03, 0.02, 0.02, 0.0, 1.0],
        dtype=np.float32,
    )
    clean_reward = env._reward(action, pose=pose, fell=False)  # noqa: SLF001

    env._last_foot_telemetry = np.array(  # noqa: SLF001
        [1.0, 0.0, 0.0, 0.03, 0.50, 0.50, 0.0, 1.0],
        dtype=np.float32,
    )
    sliding_reward = env._reward(action, pose=pose, fell=False)  # noqa: SLF001

    assert sliding_reward < clean_reward
    assert env._last_reward_terms["support_contract"] < 0.0  # noqa: SLF001
    assert env._last_reward_terms["movement_progress"] == pytest.approx(0.0)  # noqa: SLF001


def test_walk_support_contract_uses_max_foot_slip_like_physical_gate(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
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
    monkeypatch.setattr(
        env,
        "_tracked_pose_summary",
        lambda pose: {"x": pose["x"], "y": pose["y"], "z": pose["z"]},
    )
    monkeypatch.setattr(env, "_self_collision_count", lambda: 0)
    action = np.zeros(env.action_space.shape, dtype=np.float32)
    pose = env._root_pose_summary()  # noqa: SLF001
    pose["x"] = env._episode_start_x + 0.18  # noqa: SLF001
    pose["y"] = env._episode_start_y  # noqa: SLF001
    pose["yaw"] = env._episode_start_yaw  # noqa: SLF001
    pose["roll"] = 0.02
    pose["pitch"] = 0.02
    env._foot_contact_switch_count = 2  # noqa: SLF001
    env._last_foot_telemetry = np.array(  # noqa: SLF001
        [1.0, 0.0, 0.0, 0.03, 0.20, 0.20, 0.0, 1.0],
        dtype=np.float32,
    )

    env._reward(action, pose=pose, fell=False)  # noqa: SLF001

    assert env._last_reward_terms["support_contract"] == pytest.approx(0.0)  # noqa: SLF001
    assert env._last_reward_terms["movement_progress"] > 0.0  # noqa: SLF001


def test_walk_reward_penalizes_max_slip_margin_before_hard_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
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
    monkeypatch.setattr(
        env,
        "_tracked_pose_summary",
        lambda pose: {"x": pose["x"], "y": pose["y"], "z": pose["z"]},
    )
    monkeypatch.setattr(env, "_self_collision_count", lambda: 0)
    action = np.zeros(env.action_space.shape, dtype=np.float32)
    pose = env._root_pose_summary()  # noqa: SLF001
    pose["x"] = env._episode_start_x + 0.12  # noqa: SLF001
    pose["y"] = env._episode_start_y  # noqa: SLF001
    pose["yaw"] = env._episode_start_yaw  # noqa: SLF001
    pose["roll"] = 0.02
    pose["pitch"] = 0.02
    env._foot_contact_switch_count = 1  # noqa: SLF001
    env._last_foot_telemetry = np.array(  # noqa: SLF001
        [0.0, 1.0, 0.03, 0.03, 0.02, 0.02, 0.0, 1.0],
        dtype=np.float32,
    )

    env._max_foot_slip_m_s = 0.20  # noqa: SLF001
    clean_reward = env._reward(action, pose=pose, fell=False)  # noqa: SLF001
    clean_margin = env._last_reward_terms["max_foot_slip_margin"]  # noqa: SLF001

    env._max_foot_slip_m_s = 0.32  # noqa: SLF001
    margin_reward = env._reward(action, pose=pose, fell=False)  # noqa: SLF001

    assert clean_margin == pytest.approx(0.0)
    assert env._last_reward_terms["support_contract"] == pytest.approx(0.0)  # noqa: SLF001
    assert env._last_reward_terms["max_foot_slip_margin"] < 0.0  # noqa: SLF001
    assert margin_reward < clean_reward


def test_walk_support_contract_remains_failed_after_prior_slip_or_collision(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
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
    monkeypatch.setattr(
        env,
        "_tracked_pose_summary",
        lambda pose: {"x": pose["x"], "y": pose["y"], "z": pose["z"]},
    )
    monkeypatch.setattr(env, "_self_collision_count", lambda: 0)
    action = np.zeros(env.action_space.shape, dtype=np.float32)
    pose = env._root_pose_summary()  # noqa: SLF001
    pose["x"] = env._episode_start_x + 0.25  # noqa: SLF001
    pose["y"] = env._episode_start_y  # noqa: SLF001
    pose["yaw"] = env._episode_start_yaw  # noqa: SLF001
    pose["roll"] = 0.02
    pose["pitch"] = 0.02
    env._foot_contact_switch_count = 2  # noqa: SLF001
    env._max_swing_foot_clearance_m = 0.03  # noqa: SLF001
    env._last_foot_telemetry = np.array(  # noqa: SLF001
        [1.0, 0.0, 0.0, 0.03, 0.02, 0.02, 0.0, 1.0],
        dtype=np.float32,
    )
    env._max_foot_slip_m_s = 0.60  # noqa: SLF001

    env._reward(action, pose=pose, fell=False)  # noqa: SLF001

    assert env._last_reward_terms["support_contract"] < 0.0  # noqa: SLF001
    assert env._last_reward_terms["movement_progress"] == pytest.approx(0.0)  # noqa: SLF001

    env._max_foot_slip_m_s = 0.0  # noqa: SLF001
    env._max_self_collision_count = 1  # noqa: SLF001

    env._reward(action, pose=pose, fell=False)  # noqa: SLF001

    assert env._last_reward_terms["support_contract"] < 0.0  # noqa: SLF001
    assert env._last_reward_terms["movement_progress"] == pytest.approx(0.0)  # noqa: SLF001
    assert not env._immediate_success_predicate_holds(pose)  # noqa: SLF001


def test_walk_support_contract_rejects_post_contact_no_support(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
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
    monkeypatch.setattr(
        env,
        "_tracked_pose_summary",
        lambda pose: {"x": pose["x"], "y": pose["y"], "z": pose["z"]},
    )
    monkeypatch.setattr(env, "_self_collision_count", lambda: 0)
    action = np.zeros(env.action_space.shape, dtype=np.float32)
    pose = env._root_pose_summary()  # noqa: SLF001
    pose["x"] = env._episode_start_x + 0.25  # noqa: SLF001
    pose["y"] = env._episode_start_y  # noqa: SLF001
    pose["yaw"] = env._episode_start_yaw  # noqa: SLF001
    pose["roll"] = 0.02
    pose["pitch"] = 0.02
    env._foot_contact_switch_count = 2  # noqa: SLF001
    env._max_foot_slip_m_s = 0.02  # noqa: SLF001
    env._last_foot_telemetry = np.array(  # noqa: SLF001
        [0.0, 0.0, 0.03, 0.03, 0.02, 0.02, 0.0, 1.0],
        dtype=np.float32,
    )

    env._reward(action, pose=pose, fell=False)  # noqa: SLF001

    assert env._last_reward_terms["support_contract"] < 0.0  # noqa: SLF001
    assert env._last_reward_terms["movement_progress"] == pytest.approx(0.0)  # noqa: SLF001


def test_walk_episode_terminates_on_irrecoverable_support_contract_failure() -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=20,
            pca_dim=32,
        ),
    )
    env.reset(seed=0)
    env._max_self_collision_count = 1  # noqa: SLF001

    _, _, terminated, truncated, info = env.step(
        np.zeros(env.action_space.shape, dtype=np.float32)
    )

    assert terminated
    assert not truncated
    assert info["done_reason"] == "support_contract"
    assert "support_contract_terminal_penalty" in info["reward_terms"]
    assert "fall_penalty" not in info["reward_terms"]


def test_walk_episode_terminates_on_post_contact_slip_contract_failure() -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=20,
            pca_dim=32,
        ),
    )
    env.reset(seed=0)
    env._foot_contact_switch_count = 2  # noqa: SLF001
    env._max_foot_slip_m_s = 0.36  # noqa: SLF001

    _, _, terminated, truncated, info = env.step(
        np.zeros(env.action_space.shape, dtype=np.float32)
    )

    assert terminated
    assert not truncated
    assert info["done_reason"] == "support_contract"
    assert "support_contract_terminal_penalty" in info["reward_terms"]
    assert "fall_penalty" not in info["reward_terms"]


def test_walk_episode_tolerates_single_post_contact_no_support_frame(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=20,
            pca_dim=32,
        ),
    )
    env.reset(seed=0)
    env._foot_contact_switch_count = 2  # noqa: SLF001
    monkeypatch.setattr(
        env,
        "_foot_telemetry",
        lambda: np.array([0.0, 0.0, 0.03, 0.03, 0.02, 0.02, 0.0, 1.0], dtype=np.float32),
    )

    _, _, terminated, truncated, info = env.step(
        np.zeros(env.action_space.shape, dtype=np.float32)
    )

    assert not terminated
    assert not truncated
    assert info["done_reason"] is None


def test_walk_episode_terminates_on_repeated_post_contact_no_support_contract_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=20,
            pca_dim=32,
        ),
    )
    env.reset(seed=0)
    env._foot_contact_switch_count = 2  # noqa: SLF001
    monkeypatch.setattr(
        env,
        "_foot_telemetry",
        lambda: np.array([0.0, 0.0, 0.03, 0.03, 0.02, 0.02, 0.0, 1.0], dtype=np.float32),
    )

    info = {}
    terminated = False
    truncated = False
    for _ in range(3):
        _, _, terminated, truncated, info = env.step(
            np.zeros(env.action_space.shape, dtype=np.float32)
        )
        if terminated or truncated:
            break

    assert terminated
    assert not truncated
    assert info["done_reason"] == "support_contract"


def test_walk_reward_gates_progress_when_yaw_leaves_walk_corridor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
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
    env._foot_contact_switch_count = 2  # noqa: SLF001
    env._max_swing_foot_clearance_m = 0.03  # noqa: SLF001
    env._max_foot_slip_m_s = 0.02  # noqa: SLF001
    monkeypatch.setattr(
        env,
        "_tracked_pose_summary",
        lambda pose: {"x": pose["x"], "y": pose["y"], "z": pose["z"]},
    )
    action = np.zeros(env.action_space.shape, dtype=np.float32)
    root_v = env._root_qvel_idx  # noqa: SLF001
    env._data.qvel[root_v] = 0.10  # noqa: SLF001
    base_pose = env._root_pose_summary()  # noqa: SLF001
    straight_pose = dict(base_pose)
    straight_pose["x"] = env._episode_start_x + 0.35  # noqa: SLF001
    straight_pose["y"] = env._episode_start_y  # noqa: SLF001
    straight_pose["yaw"] = env._episode_start_yaw  # noqa: SLF001
    straight_pose["roll"] = 0.02
    straight_pose["pitch"] = 0.02
    yawing_pose = dict(straight_pose)
    yawing_pose["yaw"] = env._episode_start_yaw + 0.79  # noqa: SLF001

    straight_reward = env._reward(action, pose=straight_pose, fell=False)  # noqa: SLF001
    yawing_reward = env._reward(action, pose=yawing_pose, fell=False)  # noqa: SLF001

    assert env._immediate_success_predicate_holds(straight_pose) is True  # noqa: SLF001
    assert env._immediate_success_predicate_holds(yawing_pose) is False  # noqa: SLF001
    assert straight_reward > yawing_reward + 8.0


def test_walk_reward_dense_signal_rewards_alternating_contacts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
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
    monkeypatch.setattr(
        env,
        "_tracked_pose_summary",
        lambda pose: {"x": pose["x"], "y": pose["y"], "z": pose["z"]},
    )
    action = np.zeros(env.action_space.shape, dtype=np.float32)
    pose = env._root_pose_summary()  # noqa: SLF001
    pose["x"] = env._episode_start_x + 0.12  # noqa: SLF001
    pose["y"] = env._episode_start_y  # noqa: SLF001
    pose["yaw"] = env._episode_start_yaw  # noqa: SLF001
    pose["roll"] = 0.02
    pose["pitch"] = 0.02

    env._foot_contact_switch_count = 0  # noqa: SLF001
    no_switches = env._reward(action, pose=pose, fell=False)  # noqa: SLF001
    env._foot_contact_switch_count = 2  # noqa: SLF001
    alternating = env._reward(action, pose=pose, fell=False)  # noqa: SLF001

    assert alternating > no_switches + 0.5
    assert env._last_reward_terms["alternating_contact"] > 1.5  # noqa: SLF001


def test_walk_reward_penalizes_stable_standstill_without_step_progress(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=4,
            pca_dim=32,
            locomotion_action_prior="hiwonder_sine",
            locomotion_prior_residual_scale=0.01,
        ),
    )
    env.reset(seed=0)
    monkeypatch.setattr(
        env,
        "_tracked_pose_summary",
        lambda pose: {"x": pose["x"], "y": pose["y"], "z": pose["z"]},
    )
    action = np.zeros(env.action_space.shape, dtype=np.float32)
    base_pose = env._root_pose_summary()  # noqa: SLF001
    standstill_pose = dict(base_pose)
    standstill_pose["x"] = env._episode_start_x  # noqa: SLF001
    standstill_pose["y"] = env._episode_start_y  # noqa: SLF001
    standstill_pose["yaw"] = env._episode_start_yaw  # noqa: SLF001
    standstill_pose["roll"] = 0.02
    standstill_pose["pitch"] = 0.02
    stepping_pose = dict(standstill_pose)
    stepping_pose["x"] = env._episode_start_x + 0.12  # noqa: SLF001

    env._foot_contact_switch_count = 0  # noqa: SLF001
    standstill = env._reward(action, pose=standstill_pose, fell=False)  # noqa: SLF001
    env._foot_contact_switch_count = 2  # noqa: SLF001
    stepping = env._reward(action, pose=stepping_pose, fell=False)  # noqa: SLF001

    assert stepping > standstill + 4.0


def test_walk_reward_stable_standstill_is_not_profitable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
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
    monkeypatch.setattr(
        env,
        "_tracked_pose_summary",
        lambda pose: {"x": pose["x"], "y": pose["y"], "z": pose["z"]},
    )
    action = np.zeros(env.action_space.shape, dtype=np.float32)
    pose = env._root_pose_summary()  # noqa: SLF001
    pose["x"] = env._episode_start_x  # noqa: SLF001
    pose["y"] = env._episode_start_y  # noqa: SLF001
    pose["yaw"] = env._episode_start_yaw  # noqa: SLF001
    pose["roll"] = 0.02
    pose["pitch"] = 0.02
    env._foot_contact_switch_count = 0  # noqa: SLF001
    standstill = env._reward(action, pose=pose, fell=False)  # noqa: SLF001

    assert standstill < 0.0
    assert env._last_reward_terms["no_progress"] < -2.0  # noqa: SLF001
    assert env._last_reward_terms["movement_progress"] == pytest.approx(0.0)  # noqa: SLF001


def test_walk_reward_tracks_phase_conditioned_gait_prior(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
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
    monkeypatch.setattr(
        env,
        "_tracked_pose_summary",
        lambda pose: {"x": pose["x"], "y": pose["y"], "z": pose["z"]},
    )
    env._gait_phase = np.pi / 2.0  # noqa: SLF001
    env._foot_contact_switch_count = 2  # noqa: SLF001
    action = np.zeros(env.action_space.shape, dtype=np.float32)
    pose = env._root_pose_summary()  # noqa: SLF001
    pose["x"] = env._episode_start_x + 0.12  # noqa: SLF001
    pose["y"] = env._episode_start_y  # noqa: SLF001
    pose["yaw"] = env._episode_start_yaw  # noqa: SLF001
    pose["roll"] = 0.02
    pose["pitch"] = 0.02

    prior = env._locomotion_gait_prior_action()  # noqa: SLF001
    matched = env._reward(prior, pose=pose, fell=False)  # noqa: SLF001
    assert env._last_reward_terms["gait_prior"] > 0.5  # noqa: SLF001
    mismatched = env._reward(action, pose=pose, fell=False)  # noqa: SLF001

    assert np.max(np.abs(prior)) <= 1.0
    assert matched > mismatched + 0.3


def test_walk_gait_prior_reward_requires_directional_progress(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
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
    monkeypatch.setattr(
        env,
        "_tracked_pose_summary",
        lambda pose: {"x": pose["x"], "y": pose["y"], "z": pose["z"]},
    )
    env._gait_phase = np.pi / 2.0  # noqa: SLF001
    env._foot_contact_switch_count = 2  # noqa: SLF001
    prior = env._locomotion_gait_prior_action()  # noqa: SLF001
    pose = env._root_pose_summary()  # noqa: SLF001
    pose["x"] = env._episode_start_x  # noqa: SLF001
    pose["y"] = env._episode_start_y  # noqa: SLF001
    pose["yaw"] = env._episode_start_yaw  # noqa: SLF001
    pose["roll"] = 0.02
    pose["pitch"] = 0.02

    env._reward(prior, pose=pose, fell=False)  # noqa: SLF001
    assert env._last_reward_terms["gait_prior"] == pytest.approx(0.0)  # noqa: SLF001

    pose["x"] = env._episode_start_x - 0.12  # noqa: SLF001
    env._reward(prior, pose=pose, fell=False)  # noqa: SLF001
    assert env._last_reward_terms["gait_prior"] == pytest.approx(0.0)  # noqa: SLF001


def test_walk_gait_prior_reward_uses_active_locomotion_prior(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=4,
            pca_dim=32,
            locomotion_action_prior="hiwonder_contact_sine",
        ),
    )
    env.reset(seed=0)
    monkeypatch.setattr(
        env,
        "_tracked_pose_summary",
        lambda pose: {"x": pose["x"], "y": pose["y"], "z": pose["z"]},
    )
    env._foot_contact_switch_count = 2  # noqa: SLF001
    action = env._locomotion_hiwonder_contact_sine_prior_action()  # noqa: SLF001
    env._last_locomotion_prior_action = action.copy()  # noqa: SLF001
    pose = env._root_pose_summary()  # noqa: SLF001
    pose["x"] = env._episode_start_x + 0.12  # noqa: SLF001
    pose["y"] = env._episode_start_y  # noqa: SLF001
    pose["yaw"] = env._episode_start_yaw  # noqa: SLF001
    pose["roll"] = 0.02
    pose["pitch"] = 0.02

    matched = env._reward(action, pose=pose, fell=False)  # noqa: SLF001
    assert env._last_reward_terms["gait_prior"] > 0.5  # noqa: SLF001

    mismatched = env._reward(  # noqa: SLF001
        np.zeros(env.action_space.shape, dtype=np.float32),
        pose=pose,
        fell=False,
    )
    assert matched > mismatched + 0.2


def test_walk_gait_rewards_require_completed_contact_contract(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
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
    monkeypatch.setattr(
        env,
        "_tracked_pose_summary",
        lambda pose: {"x": pose["x"], "y": pose["y"], "z": pose["z"]},
    )
    env._gait_phase = np.pi / 2.0  # noqa: SLF001
    env._foot_contact_switch_count = 1  # noqa: SLF001
    env._last_foot_telemetry = np.array(  # noqa: SLF001
        [1.0, 0.0, 0.0, 0.04, 0.0, 0.0, 1.0, 0.0],
        dtype=np.float32,
    )
    prior = env._locomotion_gait_prior_action()  # noqa: SLF001
    pose = env._root_pose_summary()  # noqa: SLF001
    pose["x"] = env._episode_start_x + 0.12  # noqa: SLF001
    pose["y"] = env._episode_start_y  # noqa: SLF001
    pose["yaw"] = env._episode_start_yaw  # noqa: SLF001
    pose["roll"] = 0.02
    pose["pitch"] = 0.02

    env._reward(prior, pose=pose, fell=False)  # noqa: SLF001

    assert env._last_reward_terms["alternating_contact"] == pytest.approx(0.0)  # noqa: SLF001
    assert env._last_reward_terms["contact_cadence"] == pytest.approx(0.0)  # noqa: SLF001
    assert env._last_reward_terms["stance_contact"] == pytest.approx(0.0)  # noqa: SLF001
    assert env._last_reward_terms["foot_clearance"] == pytest.approx(0.0)  # noqa: SLF001
    assert env._last_reward_terms["gait_prior"] == pytest.approx(0.0)  # noqa: SLF001


def test_walk_reward_progress_requires_alternating_contacts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
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
    monkeypatch.setattr(
        env,
        "_tracked_pose_summary",
        lambda pose: {"x": pose["x"], "y": pose["y"], "z": pose["z"]},
    )
    action = np.zeros(env.action_space.shape, dtype=np.float32)
    pose = env._root_pose_summary()  # noqa: SLF001
    pose["x"] = env._episode_start_x + 0.12  # noqa: SLF001
    pose["y"] = env._episode_start_y  # noqa: SLF001
    pose["yaw"] = env._episode_start_yaw  # noqa: SLF001
    pose["roll"] = 0.02
    pose["pitch"] = 0.02

    env._foot_contact_switch_count = 0  # noqa: SLF001
    env._reward(action, pose=pose, fell=False)  # noqa: SLF001

    precontact_progress = env._last_reward_terms["movement_progress"]  # noqa: SLF001
    precontact_no_progress = env._last_reward_terms["no_progress"]  # noqa: SLF001
    assert precontact_progress > 0.0
    assert precontact_progress < 1.0
    assert env._last_reward_terms["alternating_contact"] == pytest.approx(0.0)  # noqa: SLF001
    assert env._last_reward_terms["no_progress"] < -2.0  # noqa: SLF001

    env._foot_contact_switch_count = 1  # noqa: SLF001
    env._reward(action, pose=pose, fell=False)  # noqa: SLF001

    assert env._last_reward_terms["alternating_contact"] == pytest.approx(0.0)  # noqa: SLF001
    assert env._last_reward_terms["contact_cadence"] == pytest.approx(0.0)  # noqa: SLF001
    partial_contact_progress = env._last_reward_terms["movement_progress"]  # noqa: SLF001

    env._foot_contact_switch_count = 2  # noqa: SLF001
    env._reward(action, pose=pose, fell=False)  # noqa: SLF001

    assert env._last_reward_terms["movement_progress"] > precontact_progress  # noqa: SLF001
    assert env._last_reward_terms["movement_progress"] > partial_contact_progress  # noqa: SLF001
    assert env._last_reward_terms["alternating_contact"] == pytest.approx(1.6)  # noqa: SLF001
    assert env._last_reward_terms["contact_cadence"] > 0.0  # noqa: SLF001
    progress_alt_contact = env._last_reward_terms["alternating_contact"]  # noqa: SLF001
    progress_contact_cadence = env._last_reward_terms["contact_cadence"]  # noqa: SLF001
    assert env._last_reward_terms["no_progress"] > precontact_no_progress  # noqa: SLF001

    pose["x"] = env._episode_start_x  # noqa: SLF001
    env._reward(action, pose=pose, fell=False)  # noqa: SLF001

    assert env._last_reward_terms["alternating_contact"] > 0.0  # noqa: SLF001
    assert env._last_reward_terms["alternating_contact"] < progress_alt_contact  # noqa: SLF001
    assert env._last_reward_terms["contact_cadence"] > 0.0  # noqa: SLF001
    assert env._last_reward_terms["contact_cadence"] < progress_contact_cadence  # noqa: SLF001
    assert env._last_reward_terms["velocity_track"] > 0.0  # noqa: SLF001
    assert env._last_reward_terms["velocity_track"] < 1.0  # noqa: SLF001


def test_walk_no_progress_penalty_is_not_forgiven_near_fall(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
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
    monkeypatch.setattr(
        env,
        "_tracked_pose_summary",
        lambda pose: {"x": pose["x"], "y": pose["y"], "z": pose["z"]},
    )
    action = np.zeros(env.action_space.shape, dtype=np.float32)
    env._foot_contact_switch_count = 2  # noqa: SLF001
    pose = env._root_pose_summary()  # noqa: SLF001
    pose["x"] = env._episode_start_x + 0.12  # noqa: SLF001
    pose["y"] = env._episode_start_y  # noqa: SLF001
    pose["yaw"] = env._episode_start_yaw  # noqa: SLF001
    pose["roll"] = 0.02
    pose["pitch"] = 0.02

    env._reward(action, pose=pose, fell=False)  # noqa: SLF001
    stable_no_progress = env._last_reward_terms["no_progress"]  # noqa: SLF001
    stable_progress = env._last_reward_terms["movement_progress"]  # noqa: SLF001

    pose["pitch"] = 0.55
    env._reward(action, pose=pose, fell=False)  # noqa: SLF001

    assert env._last_reward_terms["movement_progress"] < stable_progress  # noqa: SLF001
    assert env._last_reward_terms["no_progress"] == pytest.approx(stable_no_progress)  # noqa: SLF001
    assert env._last_reward_terms["tilt_margin"] < 0.0  # noqa: SLF001


def test_walk_reward_downscales_no_contact_target_velocity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
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
    monkeypatch.setattr(
        env,
        "_tracked_pose_summary",
        lambda pose: {"x": pose["x"], "y": pose["y"], "z": pose["z"]},
    )
    action = np.zeros(env.action_space.shape, dtype=np.float32)
    root_v = env._root_qvel_idx  # noqa: SLF001
    env._data.qvel[root_v] = 0.10  # noqa: SLF001
    pose = env._root_pose_summary()  # noqa: SLF001
    pose["x"] = env._episode_start_x  # noqa: SLF001
    pose["y"] = env._episode_start_y  # noqa: SLF001
    pose["yaw"] = env._episode_start_yaw  # noqa: SLF001
    pose["roll"] = 0.02
    pose["pitch"] = 0.02

    env._last_foot_telemetry = np.zeros(6, dtype=np.float32)  # noqa: SLF001
    env._foot_contact_switch_count = 0  # noqa: SLF001
    no_contact = env._reward(action, pose=pose, fell=False)  # noqa: SLF001
    no_contact_terms = dict(env._last_reward_terms)  # noqa: SLF001

    env._last_foot_telemetry = np.array(  # noqa: SLF001
        [1.0, 0.0, 0.0, 0.03, 0.0, 0.0],
        dtype=np.float32,
    )
    env._foot_contact_switch_count = 2  # noqa: SLF001
    pose["x"] = env._episode_start_x + 0.12  # noqa: SLF001
    supported = env._reward(action, pose=pose, fell=False)  # noqa: SLF001

    assert no_contact < 0.0
    assert no_contact_terms["no_support"] < 0.0
    assert no_contact_terms["velocity_track"] < 3.0
    assert supported > no_contact + 4.0


def test_walk_reward_penalizes_double_support_without_alternation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
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
    monkeypatch.setattr(
        env,
        "_tracked_pose_summary",
        lambda pose: {"x": pose["x"], "y": pose["y"], "z": pose["z"]},
    )
    action = np.zeros(env.action_space.shape, dtype=np.float32)
    pose = env._root_pose_summary()  # noqa: SLF001
    pose["x"] = env._episode_start_x + 0.08  # noqa: SLF001
    pose["y"] = env._episode_start_y  # noqa: SLF001
    pose["yaw"] = env._episode_start_yaw  # noqa: SLF001
    pose["roll"] = 0.02
    pose["pitch"] = 0.02

    env._last_foot_telemetry = np.array(  # noqa: SLF001
        [1.0, 1.0, 0.0, 0.0, 0.0, 0.0],
        dtype=np.float32,
    )
    env._foot_contact_switch_count = 0  # noqa: SLF001
    double_support = env._reward(action, pose=pose, fell=False)  # noqa: SLF001
    assert env._last_reward_terms["double_support"] < 0.0  # noqa: SLF001

    env._last_foot_telemetry = np.array(  # noqa: SLF001
        [1.0, 0.0, 0.0, 0.03, 0.0, 0.0],
        dtype=np.float32,
    )
    env._foot_contact_switch_count = 2  # noqa: SLF001
    alternating = env._reward(action, pose=pose, fell=False)  # noqa: SLF001

    assert alternating > double_support + 2.0


def test_profile_env_reports_reward_terms_in_step_info() -> None:
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
    _, _, _, _, info = env.step(np.zeros(env.action_space.shape, dtype=np.float32))

    terms = info["reward_terms"]
    assert terms["alive"] == pytest.approx(1.0)
    assert "velocity_track" in terms
    assert "no_progress" in terms


def test_locomotion_action_prior_is_opt_in_residual_action() -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=4,
            pca_dim=32,
            locomotion_action_prior="hiwonder_sine",
            locomotion_prior_residual_scale=0.0,
        ),
    )
    env.reset(seed=0)
    _, _, _, _, info = env.step(np.zeros(env.action_space.shape, dtype=np.float32))

    assert info["locomotion_action_prior"] == "hiwonder_sine"
    assert info["raw_action_max_abs"] == pytest.approx(0.0)
    assert info["effective_action_max_abs"] > 0.1
    assert info["locomotion_prior_action_max_abs"] > 0.1
    assert info["locomotion_prior_residual_max_abs"] == pytest.approx(0.0)
    assert info["locomotion_prior_residual_pre_guard_max_abs"] == pytest.approx(0.0)
    assert info["locomotion_prior_residual_stability_scale"] == pytest.approx(1.0)
    assert info["locomotion_prior_residual_scale"] == pytest.approx(0.0)


def test_hiwonder_contact_sine_prior_seeds_alternating_contacts() -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=60,
            pca_dim=32,
            action_scale=1.0,
            locomotion_action_prior="hiwonder_contact_sine",
            locomotion_prior_residual_scale=0.0,
            locomotion_prior_feedback_pitch=2.0,
            locomotion_prior_feedback_roll=0.5,
        ),
    )
    env.reset(seed=0)
    info = {}
    for _ in range(60):
        _, _, terminated, truncated, info = env.step(
            np.zeros(env.action_space.shape, dtype=np.float32)
        )
        if terminated or truncated:
            break

    assert info["locomotion_action_prior"] == "hiwonder_contact_sine"
    assert env._foot_contact_switch_count >= 2  # noqa: SLF001
    assert info["tracked_delta_x"] > 0.01
    assert abs(info["delta_yaw"]) < 0.40
    assert info["max_foot_slip_m_s"] > 0.35
    assert info["done_reason"] == "support_contract"


def test_locomotion_action_prior_reports_residual_authority() -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=4,
            pca_dim=32,
            locomotion_action_prior="hiwonder_sine",
            locomotion_prior_residual_scale=0.25,
        ),
    )
    env.reset(seed=0)
    raw = np.ones(env.action_space.shape, dtype=np.float32)
    _, _, _, _, info = env.step(raw)

    assert info["locomotion_action_prior"] == "hiwonder_sine"
    assert info["raw_action_max_abs"] == pytest.approx(1.0)
    assert info["locomotion_prior_action_max_abs"] > 0.1
    assert info["locomotion_prior_residual_max_abs"] <= 0.400001
    assert info["locomotion_prior_residual_pre_guard_max_abs"] <= 0.400001
    assert info["locomotion_prior_residual_stability_scale"] <= 1.0
    assert info["locomotion_prior_residual_scale"] == pytest.approx(0.25)


def test_locomotion_action_prior_rewards_effective_action(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=4,
            pca_dim=32,
            locomotion_action_prior="hiwonder_sine",
            locomotion_prior_residual_scale=0.0,
        ),
    )
    env.reset(seed=0)
    seen: dict[str, np.ndarray] = {}

    def capture_reward(
        action: np.ndarray,
        *,
        pose: dict[str, float],
        fell: bool,
        support_contract_terminated: bool = False,
    ) -> float:
        del pose, fell, support_contract_terminated
        seen["action"] = np.asarray(action, dtype=np.float32).copy()
        return 0.0

    monkeypatch.setattr(env, "_reward", capture_reward)
    raw = np.zeros(env.action_space.shape, dtype=np.float32)
    _, _, _, _, info = env.step(raw)

    assert np.max(np.abs(seen["action"])) == pytest.approx(
        info["effective_action_max_abs"],
    )
    assert np.max(np.abs(seen["action"])) > 0.1
    assert not np.allclose(seen["action"], raw)


def test_locomotion_action_prior_balance_feedback_changes_effective_action(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=4,
            pca_dim=32,
            locomotion_action_prior="hiwonder_sine",
            locomotion_prior_residual_scale=0.0,
            locomotion_prior_feedback_pitch=2.0,
            locomotion_prior_feedback_roll=-1.5,
            locomotion_prior_feedback_yaw=0.25,
        ),
    )
    env.reset(seed=0)
    pose = env._root_pose_summary()  # noqa: SLF001
    pose["pitch"] = 0.1
    pose["roll"] = -0.1
    pose["yaw"] = env._episode_start_yaw + 0.1  # noqa: SLF001
    monkeypatch.setattr(env, "_root_pose_summary", lambda: dict(pose))
    prior = env._locomotion_hiwonder_sine_prior_action()  # noqa: SLF001
    corrected = env._apply_locomotion_prior_balance_feedback(prior)  # noqa: SLF001

    assert np.max(np.abs(corrected - prior)) > 0.0
    assert np.max(np.abs(corrected)) <= 1.0


def test_locomotion_action_prior_pitch_feedback_is_side_aware(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=4,
            pca_dim=32,
            locomotion_action_prior="hiwonder_low_slip_contact_sine",
            locomotion_prior_residual_scale=0.0,
            locomotion_prior_feedback_pitch=2.0,
        ),
    )
    env.reset(seed=0)
    pose = env._root_pose_summary()  # noqa: SLF001
    pose["pitch"] = 0.1
    pose["roll"] = 0.0
    pose["yaw"] = env._episode_start_yaw  # noqa: SLF001
    monkeypatch.setattr(env, "_root_pose_summary", lambda: dict(pose))
    prior = np.zeros(env.action_space.shape, dtype=np.float32)

    corrected = env._apply_locomotion_prior_balance_feedback(prior)  # noqa: SLF001
    hip_pitch = [
        float(corrected[idx])
        for idx, joint in enumerate(env._action_joints)  # noqa: SLF001
        if "hip_pitch" in joint.name.lower()
    ]
    ank_pitch = [
        float(corrected[idx])
        for idx, joint in enumerate(env._action_joints)  # noqa: SLF001
        if "ank_pitch" in joint.name.lower()
    ]

    assert len(hip_pitch) >= 2
    assert len(ank_pitch) >= 2
    assert min(hip_pitch) < 0.0 < max(hip_pitch)
    assert min(ank_pitch) < 0.0 < max(ank_pitch)


def test_locomotion_pitch_feedback_weights_stance_leg_near_fall(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=4,
            pca_dim=32,
            locomotion_action_prior="hiwonder_low_slip_contact_sine",
            locomotion_prior_residual_scale=0.0,
            locomotion_prior_feedback_pitch=2.0,
        ),
    )
    env.reset(seed=0)
    pose = env._root_pose_summary()  # noqa: SLF001
    pose["pitch"] = 0.45
    pose["roll"] = 0.0
    pose["yaw"] = env._episode_start_yaw  # noqa: SLF001
    env._last_foot_telemetry = np.array(  # noqa: SLF001
        [1.0, 0.0, 0.0, 0.03, 0.02, 0.02, 0.0, 1.0],
        dtype=np.float32,
    )
    monkeypatch.setattr(env, "_root_pose_summary", lambda: dict(pose))
    prior = np.zeros(env.action_space.shape, dtype=np.float32)

    corrected = env._apply_locomotion_prior_balance_feedback(prior)  # noqa: SLF001
    left_hip_pitch = [
        abs(float(corrected[idx]))
        for idx, joint in enumerate(env._action_joints)  # noqa: SLF001
        if joint.name.lower().startswith(("l_", "left_"))
        and "hip_pitch" in joint.name.lower()
    ]
    right_hip_pitch = [
        abs(float(corrected[idx]))
        for idx, joint in enumerate(env._action_joints)  # noqa: SLF001
        if joint.name.lower().startswith(("r_", "right_"))
        and "hip_pitch" in joint.name.lower()
    ]

    assert left_hip_pitch
    assert right_hip_pitch
    assert max(left_hip_pitch) > max(right_hip_pitch) * 3.0


def test_locomotion_pitch_feedback_adds_emergency_brace_near_fall(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=4,
            pca_dim=32,
            locomotion_action_prior="hiwonder_low_slip_contact_sine",
            locomotion_prior_residual_scale=0.0,
            locomotion_prior_feedback_pitch=0.1,
        ),
    )
    env.reset(seed=0)
    pose = env._root_pose_summary()  # noqa: SLF001
    pose["pitch"] = 0.54
    pose["roll"] = 0.0
    pose["yaw"] = env._episode_start_yaw  # noqa: SLF001
    monkeypatch.setattr(env, "_root_pose_summary", lambda: dict(pose))
    prior = np.zeros(env.action_space.shape, dtype=np.float32)

    corrected = env._apply_locomotion_prior_balance_feedback(prior)  # noqa: SLF001
    knee_values = [
        float(corrected[idx])
        for idx, joint in enumerate(env._action_joints)  # noqa: SLF001
        if "knee" in joint.name.lower()
    ]
    hip_pitch_values = [
        float(corrected[idx])
        for idx, joint in enumerate(env._action_joints)  # noqa: SLF001
        if "hip_pitch" in joint.name.lower()
    ]
    ank_pitch_values = [
        float(corrected[idx])
        for idx, joint in enumerate(env._action_joints)  # noqa: SLF001
        if "ank_pitch" in joint.name.lower()
    ]

    assert min(knee_values) > 0.0
    assert max(hip_pitch_values) < 0.0
    assert min(ank_pitch_values) > 0.0


def test_locomotion_action_prior_balance_feedback_clamps_yaw_correction(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=4,
            pca_dim=32,
            locomotion_action_prior="hiwonder_sine",
            locomotion_prior_residual_scale=0.0,
            locomotion_prior_feedback_yaw=5.0,
        ),
    )
    env.reset(seed=0)
    pose = env._root_pose_summary()  # noqa: SLF001
    pose["pitch"] = 0.0
    pose["roll"] = 0.0
    pose["yaw"] = env._episode_start_yaw + 1.0  # noqa: SLF001
    monkeypatch.setattr(env, "_root_pose_summary", lambda: dict(pose))
    prior = np.zeros(env.action_space.shape, dtype=np.float32)

    corrected = env._apply_locomotion_prior_balance_feedback(prior)  # noqa: SLF001
    hip_yaw_values = [
        abs(float(corrected[idx]))
        for idx, joint in enumerate(env._action_joints)  # noqa: SLF001
        if "hip_yaw" in joint.name.lower()
    ]

    assert hip_yaw_values
    assert max(hip_yaw_values) == pytest.approx(0.35)


def test_locomotion_action_prior_balance_feedback_softens_near_fall_tilt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=4,
            pca_dim=32,
            locomotion_action_prior="hiwonder_sine",
            locomotion_prior_residual_scale=0.0,
            locomotion_prior_feedback_yaw=0.1,
        ),
    )
    env.reset(seed=0)
    pose = env._root_pose_summary()  # noqa: SLF001
    pose["pitch"] = 0.42
    pose["roll"] = 0.0
    pose["yaw"] = env._episode_start_yaw  # noqa: SLF001
    monkeypatch.setattr(env, "_root_pose_summary", lambda: dict(pose))
    prior = np.full(env.action_space.shape, 0.5, dtype=np.float32)

    corrected = env._apply_locomotion_prior_balance_feedback(prior)  # noqa: SLF001

    assert np.max(np.abs(corrected)) < np.max(np.abs(prior))
    assert np.max(np.abs(corrected)) == pytest.approx(0.4)


def test_locomotion_action_prior_tapers_near_goal_hold(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=4,
            pca_dim=32,
            locomotion_action_prior="hiwonder_contact_sine",
            locomotion_prior_residual_scale=0.0,
        ),
    )
    env.reset(seed=0)
    pose = env._root_pose_summary()  # noqa: SLF001
    pose["pitch"] = 0.0
    pose["roll"] = 0.0
    tracked = env._tracked_pose_summary(pose)  # noqa: SLF001
    tracked["x"] = env._episode_start_tracked_x + 0.34  # noqa: SLF001
    env._foot_contact_switch_count = 2  # noqa: SLF001
    monkeypatch.setattr(env, "_root_pose_summary", lambda: dict(pose))
    monkeypatch.setattr(env, "_tracked_pose_summary", lambda _pose: dict(tracked))
    prior = np.full(env.action_space.shape, 0.5, dtype=np.float32)

    tapered = env._apply_locomotion_prior_goal_hold_taper(prior)  # noqa: SLF001

    assert env._last_locomotion_prior_goal_hold_scale < 1.0  # noqa: SLF001
    assert env._last_locomotion_prior_goal_hold_scale <= 0.10  # noqa: SLF001
    assert np.max(np.abs(tapered)) < np.max(np.abs(prior))


def test_locomotion_action_prior_does_not_goal_hold_before_forward_target(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=4,
            pca_dim=32,
            locomotion_action_prior="hiwonder_contact_sine",
            locomotion_prior_residual_scale=0.0,
        ),
    )
    env.reset(seed=0)
    pose = env._root_pose_summary()  # noqa: SLF001
    pose["pitch"] = 0.0
    pose["roll"] = 0.0
    tracked = env._tracked_pose_summary(pose)  # noqa: SLF001
    tracked["x"] = env._episode_start_tracked_x + 0.29  # noqa: SLF001
    env._foot_contact_switch_count = 2  # noqa: SLF001
    monkeypatch.setattr(env, "_root_pose_summary", lambda: dict(pose))
    monkeypatch.setattr(env, "_tracked_pose_summary", lambda _pose: dict(tracked))
    prior = np.full(env.action_space.shape, 0.5, dtype=np.float32)

    tapered = env._apply_locomotion_prior_goal_hold_taper(prior)  # noqa: SLF001

    assert env._last_locomotion_prior_goal_hold_scale == pytest.approx(1.0)  # noqa: SLF001
    np.testing.assert_allclose(tapered, prior)


def test_locomotion_action_prior_tapers_near_fall_tilt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=4,
            pca_dim=32,
            locomotion_action_prior="hiwonder_contact_sine",
            locomotion_prior_residual_scale=0.0,
        ),
    )
    env.reset(seed=0)
    pose = env._root_pose_summary()  # noqa: SLF001
    pose["pitch"] = 0.50
    pose["roll"] = 0.0
    monkeypatch.setattr(env, "_root_pose_summary", lambda: dict(pose))
    prior = np.full(env.action_space.shape, 0.5, dtype=np.float32)

    tapered = env._apply_locomotion_prior_goal_hold_taper(prior)  # noqa: SLF001

    assert env._last_locomotion_prior_goal_hold_scale < 1.0  # noqa: SLF001
    assert np.max(np.abs(tapered)) < np.max(np.abs(prior))


def test_locomotion_action_prior_tapers_near_fall_height(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=4,
            pca_dim=32,
            locomotion_action_prior="hiwonder_low_slip_contact_sine",
            locomotion_prior_residual_scale=0.0,
        ),
    )
    env.reset(seed=0)
    pose = env._root_pose_summary()  # noqa: SLF001
    pose["z"] = env._stand_height_m * 0.75  # noqa: SLF001
    pose["pitch"] = 0.0
    pose["roll"] = 0.0
    monkeypatch.setattr(env, "_root_pose_summary", lambda: dict(pose))
    prior = np.full(env.action_space.shape, 0.5, dtype=np.float32)

    tapered = env._apply_locomotion_prior_goal_hold_taper(prior)  # noqa: SLF001

    assert 0.30 < env._last_locomotion_prior_goal_hold_scale < 0.60  # noqa: SLF001
    assert np.max(np.abs(tapered)) < np.max(np.abs(prior))


def test_locomotion_action_prior_tapers_near_yaw_bound(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=4,
            pca_dim=32,
            locomotion_action_prior="hiwonder_contact_sine",
            locomotion_prior_residual_scale=0.0,
        ),
    )
    env.reset(seed=0)
    pose = env._root_pose_summary()  # noqa: SLF001
    pose["pitch"] = 0.0
    pose["roll"] = 0.0
    pose["yaw"] = env._episode_start_yaw + 0.40  # noqa: SLF001
    monkeypatch.setattr(env, "_root_pose_summary", lambda: dict(pose))
    prior = np.full(env.action_space.shape, 0.5, dtype=np.float32)

    tapered = env._apply_locomotion_prior_goal_hold_taper(prior)  # noqa: SLF001

    assert env._last_locomotion_prior_goal_hold_scale <= 0.10  # noqa: SLF001
    assert np.max(np.abs(tapered)) <= 0.05


def test_locomotion_action_prior_tapers_near_slip_bound() -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=4,
            pca_dim=32,
            locomotion_action_prior="hiwonder_contact_sine",
            locomotion_prior_residual_scale=0.0,
        ),
    )
    env.reset(seed=0)
    env._foot_contact_switch_count = 2  # noqa: SLF001
    env._max_foot_slip_m_s = 0.35  # noqa: SLF001
    prior = np.full(env.action_space.shape, 0.5, dtype=np.float32)

    tapered = env._apply_locomotion_prior_goal_hold_taper(prior)  # noqa: SLF001

    assert env._last_locomotion_prior_goal_hold_scale < 0.25  # noqa: SLF001
    assert np.max(np.abs(tapered)) < 0.125


def test_locomotion_action_prior_tapers_slip_before_required_contacts() -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=4,
            pca_dim=32,
            locomotion_action_prior="hiwonder_low_slip_contact_sine",
            locomotion_prior_residual_scale=0.0,
        ),
    )
    env.reset(seed=0)
    env._foot_contact_switch_count = 1  # noqa: SLF001
    env._max_foot_slip_m_s = 0.35  # noqa: SLF001
    prior = np.full(env.action_space.shape, 0.5, dtype=np.float32)

    tapered = env._apply_locomotion_prior_goal_hold_taper(prior)  # noqa: SLF001

    assert env._last_locomotion_prior_goal_hold_scale == pytest.approx(0.35)  # noqa: SLF001
    assert np.max(np.abs(tapered)) == pytest.approx(0.175)


def test_locomotion_landing_guard_dampens_near_touchdown_swing_leg() -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=4,
            pca_dim=32,
            locomotion_action_prior="hiwonder_low_slip_contact_sine",
            locomotion_prior_residual_scale=0.0,
        ),
    )
    env.reset(seed=0)
    env._last_foot_telemetry = np.array(  # noqa: SLF001
        [0.0, 1.0, 0.040, 0.034, 0.0, 0.05, 0.0, 0.0],
        dtype=np.float32,
    )
    prior = np.full(env.action_space.shape, 0.5, dtype=np.float32)

    guarded = env._apply_locomotion_prior_landing_guard(prior)  # noqa: SLF001

    left_leg_values = [
        guarded[idx]
        for idx, joint in enumerate(env._action_joints)  # noqa: SLF001
        if joint.name.lower().startswith("l_")
        and (
            "hip_pitch" in joint.name.lower()
            or "knee" in joint.name.lower()
            or "ank_pitch" in joint.name.lower()
        )
    ]
    assert env._last_locomotion_prior_landing_guard_scale > 0.0  # noqa: SLF001
    assert left_leg_values
    assert max(left_leg_values) < 0.5


def test_locomotion_landing_guard_reacts_to_stance_slip_before_touchdown() -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=4,
            pca_dim=32,
            locomotion_action_prior="hiwonder_low_slip_contact_sine",
            locomotion_prior_residual_scale=0.0,
        ),
    )
    env.reset(seed=0)
    env._max_foot_slip_m_s = 0.34  # noqa: SLF001
    env._last_foot_telemetry = np.array(  # noqa: SLF001
        [0.0, 1.0, 0.060, 0.034, 0.0, 0.34, 0.0, 0.0],
        dtype=np.float32,
    )
    prior = np.full(env.action_space.shape, 0.5, dtype=np.float32)

    guarded = env._apply_locomotion_prior_landing_guard(prior)  # noqa: SLF001

    left_leg_values = [
        guarded[idx]
        for idx, joint in enumerate(env._action_joints)  # noqa: SLF001
        if joint.name.lower().startswith("l_")
        and (
            "hip_pitch" in joint.name.lower()
            or "knee" in joint.name.lower()
            or "ank_pitch" in joint.name.lower()
        )
    ]
    assert env._last_locomotion_prior_landing_gap_guard_scale == pytest.approx(0.0)  # noqa: SLF001
    assert env._last_locomotion_prior_stance_slip_guard_scale > 0.0  # noqa: SLF001
    assert env._last_locomotion_prior_landing_guard_scale > 0.0  # noqa: SLF001
    assert env._last_locomotion_prior_landing_gap_m > 0.004  # noqa: SLF001
    assert left_leg_values
    assert max(left_leg_values) < 0.5


def test_locomotion_landing_guard_uses_current_stance_slip_not_latched_max() -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=4,
            pca_dim=32,
            locomotion_action_prior="hiwonder_low_slip_contact_sine",
            locomotion_prior_residual_scale=0.0,
        ),
    )
    env.reset(seed=0)
    env._max_foot_slip_m_s = 0.35  # noqa: SLF001
    env._last_foot_telemetry = np.array(  # noqa: SLF001
        [0.0, 1.0, 0.060, 0.034, 0.0, 0.05, 0.0, 0.0],
        dtype=np.float32,
    )
    prior = np.full(env.action_space.shape, 0.5, dtype=np.float32)

    guarded = env._apply_locomotion_prior_landing_guard(prior)  # noqa: SLF001

    assert env._last_locomotion_prior_landing_gap_guard_scale == pytest.approx(0.0)  # noqa: SLF001
    assert env._last_locomotion_prior_stance_slip_guard_scale == pytest.approx(0.0)  # noqa: SLF001
    assert env._last_locomotion_prior_landing_guard_scale == pytest.approx(0.0)  # noqa: SLF001
    assert env._last_locomotion_prior_stance_slip_ratio == pytest.approx(0.05 / 0.35)  # noqa: SLF001
    np.testing.assert_allclose(guarded, prior)


def test_locomotion_landing_guard_starts_before_touchdown_impact() -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=4,
            pca_dim=32,
            locomotion_action_prior="hiwonder_low_slip_contact_sine",
            locomotion_prior_residual_scale=0.0,
        ),
    )
    env.reset(seed=0)
    env._last_foot_telemetry = np.array(  # noqa: SLF001
        [0.0, 1.0, 0.046, 0.034, 0.0, 0.05, 0.0, 0.0],
        dtype=np.float32,
    )
    prior = np.full(env.action_space.shape, 0.5, dtype=np.float32)

    guarded = env._apply_locomotion_prior_landing_guard(prior)  # noqa: SLF001

    left_leg_values = [
        guarded[idx]
        for idx, joint in enumerate(env._action_joints)  # noqa: SLF001
        if joint.name.lower().startswith("l_")
        and (
            "hip_pitch" in joint.name.lower()
            or "knee" in joint.name.lower()
            or "ank_pitch" in joint.name.lower()
        )
    ]
    assert env._last_locomotion_prior_landing_gap_m == pytest.approx(0.012)  # noqa: SLF001
    assert env._last_locomotion_prior_landing_gap_guard_scale > 0.0  # noqa: SLF001
    assert env._last_locomotion_prior_stance_slip_guard_scale == pytest.approx(0.0)  # noqa: SLF001
    assert left_leg_values
    assert max(left_leg_values) < 0.5


def test_locomotion_landing_guard_ignores_double_support() -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=4,
            pca_dim=32,
            locomotion_action_prior="hiwonder_low_slip_contact_sine",
            locomotion_prior_residual_scale=0.0,
        ),
    )
    env.reset(seed=0)
    env._last_foot_telemetry = np.array(  # noqa: SLF001
        [1.0, 1.0, 0.026, 0.034, 0.0, 0.05, 0.0, 0.0],
        dtype=np.float32,
    )
    prior = np.full(env.action_space.shape, 0.5, dtype=np.float32)

    guarded = env._apply_locomotion_prior_landing_guard(prior)  # noqa: SLF001

    assert env._last_locomotion_prior_landing_guard_scale == pytest.approx(0.0)  # noqa: SLF001
    np.testing.assert_allclose(guarded, prior)


def test_locomotion_capture_plant_waits_for_required_contacts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=4,
            pca_dim=32,
            locomotion_action_prior="hiwonder_sine",
            locomotion_prior_residual_scale=0.0,
        ),
    )
    env.reset(seed=0)
    pose = env._root_pose_summary()  # noqa: SLF001
    pose["pitch"] = 0.0
    pose["roll"] = 0.0
    tracked = env._tracked_pose_summary(pose)  # noqa: SLF001
    tracked["x"] = env._episode_start_tracked_x + 0.34  # noqa: SLF001
    monkeypatch.setattr(env, "_root_pose_summary", lambda: dict(pose))
    monkeypatch.setattr(env, "_tracked_pose_summary", lambda _pose: dict(tracked))
    env._foot_contact_switch_count = 1  # noqa: SLF001
    prior = np.full(env.action_space.shape, 0.5, dtype=np.float32)

    planted = env._apply_locomotion_prior_capture_plant(prior)  # noqa: SLF001

    assert np.array_equal(planted, prior)


def test_locomotion_capture_plant_braces_after_contacts_and_progress(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=4,
            pca_dim=32,
            locomotion_action_prior="hiwonder_sine",
            locomotion_prior_residual_scale=0.0,
        ),
    )
    env.reset(seed=0)
    pose = env._root_pose_summary()  # noqa: SLF001
    pose["pitch"] = 0.35
    pose["roll"] = 0.05
    pose["yaw"] = env._episode_start_yaw + 0.35  # noqa: SLF001
    tracked = env._tracked_pose_summary(pose)  # noqa: SLF001
    tracked["x"] = env._episode_start_tracked_x + 0.31  # noqa: SLF001
    monkeypatch.setattr(env, "_root_pose_summary", lambda: dict(pose))
    monkeypatch.setattr(env, "_tracked_pose_summary", lambda _pose: dict(tracked))
    env._foot_contact_switch_count = 2  # noqa: SLF001
    prior = np.full(env.action_space.shape, 0.5, dtype=np.float32)

    planted = env._apply_locomotion_prior_capture_plant(prior)  # noqa: SLF001
    knee_values = [
        float(planted[idx])
        for idx, joint in enumerate(env._action_joints)  # noqa: SLF001
        if "knee" in joint.name.lower()
    ]
    hip_pitch_values = [
        float(planted[idx])
        for idx, joint in enumerate(env._action_joints)  # noqa: SLF001
        if "hip_pitch" in joint.name.lower()
    ]

    assert np.max(np.abs(planted - prior)) > 0.1
    assert min(knee_values) < 0.5
    assert max(hip_pitch_values) < 0.5


def test_low_slip_locomotion_prior_keeps_recovery_floor_near_fall_tilt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=4,
            pca_dim=32,
            locomotion_action_prior="hiwonder_low_slip_contact_sine",
            locomotion_prior_residual_scale=0.0,
        ),
    )
    env.reset(seed=0)
    pose = env._root_pose_summary()  # noqa: SLF001
    pose["pitch"] = 0.50
    pose["roll"] = 0.0
    monkeypatch.setattr(env, "_root_pose_summary", lambda: dict(pose))
    prior = np.full(env.action_space.shape, 0.5, dtype=np.float32)

    tapered = env._apply_locomotion_prior_goal_hold_taper(prior)  # noqa: SLF001

    assert env._last_locomotion_prior_goal_hold_scale == pytest.approx(0.35)  # noqa: SLF001
    assert np.max(np.abs(tapered)) == pytest.approx(0.175)


def test_locomotion_balance_feedback_survives_goal_hold_taper(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=4,
            pca_dim=32,
            locomotion_action_prior="hiwonder_low_slip_contact_sine",
            locomotion_prior_residual_scale=0.0,
            locomotion_prior_feedback_pitch=2.0,
        ),
    )
    env.reset(seed=0)
    pose = env._root_pose_summary()  # noqa: SLF001
    pose["pitch"] = 0.50
    pose["roll"] = 0.0
    pose["yaw"] = env._episode_start_yaw  # noqa: SLF001
    tracked = env._tracked_pose_summary(pose)  # noqa: SLF001
    tracked["x"] = env._episode_start_tracked_x + 0.34  # noqa: SLF001
    env._foot_contact_switch_count = 2  # noqa: SLF001
    monkeypatch.setattr(env, "_root_pose_summary", lambda: dict(pose))
    monkeypatch.setattr(env, "_tracked_pose_summary", lambda _pose: dict(tracked))
    monkeypatch.setattr(
        env,
        "_locomotion_hiwonder_low_slip_contact_sine_prior_action",
        lambda: np.zeros(env.action_space.shape, dtype=np.float32),
    )
    raw = np.zeros(env.action_space.shape, dtype=np.float32)

    effective = env._apply_locomotion_action_prior(raw)  # noqa: SLF001

    assert env._last_locomotion_prior_goal_hold_scale <= 0.35  # noqa: SLF001
    assert np.max(np.abs(effective)) > 0.20


@pytest.mark.parametrize(
    ("prior_name", "method_name"),
    (
        ("hiwonder_sine", "_locomotion_hiwonder_sine_prior_action"),
        ("hiwonder_contact_sine", "_locomotion_hiwonder_contact_sine_prior_action"),
        (
            "hiwonder_low_slip_contact_sine",
            "_locomotion_hiwonder_low_slip_contact_sine_prior_action",
        ),
    ),
)
def test_locomotion_yaw_feedback_survives_goal_hold_taper(
    monkeypatch: pytest.MonkeyPatch,
    prior_name: str,
    method_name: str,
) -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=4,
            pca_dim=32,
            locomotion_action_prior=prior_name,
            locomotion_prior_residual_scale=0.0,
            locomotion_prior_feedback_yaw=1.5,
        ),
    )
    env.reset(seed=0)
    pose = env._root_pose_summary()  # noqa: SLF001
    pose["pitch"] = 0.0
    pose["roll"] = 0.0
    pose["yaw"] = env._episode_start_yaw + 0.405  # noqa: SLF001
    env._foot_contact_switch_count = 0  # noqa: SLF001
    monkeypatch.setattr(env, "_root_pose_summary", lambda: dict(pose))
    monkeypatch.setattr(
        env,
        method_name,
        lambda: np.zeros(env.action_space.shape, dtype=np.float32),
    )
    raw = np.zeros(env.action_space.shape, dtype=np.float32)

    effective = env._apply_locomotion_action_prior(raw)  # noqa: SLF001
    hip_yaw = np.array(
        [
            effective[idx]
            for idx, joint in enumerate(env._action_joints)  # noqa: SLF001
            if "hip_yaw" in joint.name.lower()
        ],
        dtype=np.float32,
    )

    expected_scale_ceiling = (
        0.35 if prior_name == "hiwonder_low_slip_contact_sine" else 0.10
    )
    assert env._last_locomotion_prior_goal_hold_scale <= expected_scale_ceiling  # noqa: SLF001
    assert hip_yaw.size >= 2
    assert np.max(np.abs(hip_yaw)) > 0.20


def test_locomotion_prior_residual_is_constrained_to_stable_stride_joints(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=4,
            pca_dim=32,
            locomotion_action_prior="hiwonder_sine",
            locomotion_prior_residual_scale=0.25,
        ),
    )
    env.reset(seed=0)
    pose = env._root_pose_summary()  # noqa: SLF001
    pose["pitch"] = 0.0
    pose["roll"] = 0.0
    pose["yaw"] = env._episode_start_yaw  # noqa: SLF001
    monkeypatch.setattr(env, "_root_pose_summary", lambda: dict(pose))
    raw = np.ones(env.action_space.shape, dtype=np.float32)

    residual = env._locomotion_prior_residual_action(raw)  # noqa: SLF001

    assert np.max(np.abs(residual)) <= 0.400001
    for idx, joint in enumerate(env._action_joints):  # noqa: SLF001
        name = joint.name.lower()
        if "hip_yaw" in name:
            assert residual[idx] == 0.0
        elif "hip_roll" in name or "ank_roll" in name:
            assert residual[idx] == pytest.approx(0.25)
        elif "hip_pitch" in name or "knee" in name or "ank_pitch" in name:
            assert residual[idx] == pytest.approx(0.4)


def test_locomotion_prior_residual_shrinks_near_yaw_bound(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=4,
            pca_dim=32,
            locomotion_action_prior="hiwonder_sine",
            locomotion_prior_residual_scale=0.25,
        ),
    )
    env.reset(seed=0)
    pose = env._root_pose_summary()  # noqa: SLF001
    pose["pitch"] = 0.0
    pose["roll"] = 0.0
    pose["yaw"] = env._episode_start_yaw + 0.4  # noqa: SLF001
    monkeypatch.setattr(env, "_root_pose_summary", lambda: dict(pose))
    raw = np.ones(env.action_space.shape, dtype=np.float32)

    residual = env._locomotion_prior_residual_action(raw)  # noqa: SLF001

    assert np.max(np.abs(residual)) == 0.0


def test_hiwonder_stride_mod_residual_preserves_symmetric_gait_structure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=4,
            pca_dim=32,
            locomotion_action_prior="hiwonder_sine",
            locomotion_prior_residual_scale=1.0,
            locomotion_prior_residual_mode="hiwonder_stride_mod",
        ),
    )
    env.reset(seed=0)
    pose = env._root_pose_summary()  # noqa: SLF001
    pose["pitch"] = 0.0
    pose["roll"] = 0.0
    pose["yaw"] = env._episode_start_yaw  # noqa: SLF001
    monkeypatch.setattr(env, "_root_pose_summary", lambda: dict(pose))
    raw = np.ones(env.action_space.shape, dtype=np.float32)

    residual = env._locomotion_prior_residual_action(raw)  # noqa: SLF001

    assert np.max(np.abs(residual)) <= 0.180001
    assert np.count_nonzero(np.abs(residual) > 1e-6) > 0
    for idx, joint in enumerate(env._action_joints):  # noqa: SLF001
        if "hip_yaw" in joint.name.lower():
            assert residual[idx] == 0.0


def test_hiwonder_stride_mod_residual_centers_on_contact_sine_prior(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=4,
            pca_dim=32,
            locomotion_action_prior="hiwonder_contact_sine",
            locomotion_prior_residual_scale=1.0,
            locomotion_prior_residual_mode="hiwonder_stride_mod",
        ),
    )
    env.reset(seed=0)
    pose = env._root_pose_summary()  # noqa: SLF001
    pose["pitch"] = 0.0
    pose["roll"] = 0.0
    pose["yaw"] = env._episode_start_yaw  # noqa: SLF001
    monkeypatch.setattr(env, "_root_pose_summary", lambda: dict(pose))
    raw = np.ones(env.action_space.shape, dtype=np.float32)

    residual = env._locomotion_prior_residual_action(raw)  # noqa: SLF001
    params = env._locomotion_hiwonder_contact_sine_params()  # noqa: SLF001
    mod = dict(params)
    mod["hz"] += 0.30
    mod["hip_amp"] += 0.045
    mod["knee_amp"] += 0.035
    mod["ank_amp"] += 0.025
    mod["ank_amp"] += 0.035
    mod["ank_phase"] += 0.18
    mod["hip_bias"] += 0.015
    mod["knee_bias"] += 0.035
    mod["ank_bias"] -= 0.025
    mod["hip_bias"] -= 0.015
    expected = np.clip(
        env._locomotion_hiwonder_sine_action_from_params(mod)  # noqa: SLF001
        - env._locomotion_hiwonder_sine_action_from_params(params),  # noqa: SLF001
        -0.18,
        0.18,
    )

    for idx, joint in enumerate(env._action_joints):  # noqa: SLF001
        if "hip_yaw" in joint.name.lower():
            expected[idx] = 0.0
    np.testing.assert_allclose(residual, expected.astype(np.float32), atol=1e-6)


def test_hiwonder_stride_mod_residual_uses_named_leg_groups(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=4,
            pca_dim=32,
            locomotion_action_prior="hiwonder_sine",
            locomotion_prior_residual_scale=1.0,
            locomotion_prior_residual_mode="hiwonder_stride_mod",
        ),
    )
    env.reset(seed=0)
    pose = env._root_pose_summary()  # noqa: SLF001
    pose["pitch"] = 0.0
    pose["roll"] = 0.0
    pose["yaw"] = env._episode_start_yaw  # noqa: SLF001
    monkeypatch.setattr(env, "_root_pose_summary", lambda: dict(pose))
    env._step_count = 10  # noqa: SLF001
    hip_yaw_only = np.zeros(env.action_space.shape, dtype=np.float32)
    pitch_only = np.zeros(env.action_space.shape, dtype=np.float32)
    for idx, joint in enumerate(env._action_joints):  # noqa: SLF001
        name = joint.name.lower()
        if "hip_yaw" in name:
            hip_yaw_only[idx] = 1.0
        if "hip_pitch" in name or "knee" in name or "ank_pitch" in name:
            pitch_only[idx] = 1.0

    timing_residual = env._locomotion_prior_residual_action(hip_yaw_only)  # noqa: SLF001
    pitch_residual = env._locomotion_prior_residual_action(pitch_only)  # noqa: SLF001

    assert np.max(np.abs(timing_residual)) > 0.0
    for idx, joint in enumerate(env._action_joints):  # noqa: SLF001
        if "hip_yaw" in joint.name.lower():
            assert timing_residual[idx] == 0.0
    assert np.max(np.abs(pitch_residual)) > 0.0


def test_walk_reward_damps_no_progress_penalty_near_yaw_bound(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
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
    monkeypatch.setattr(
        env,
        "_tracked_pose_summary",
        lambda pose: {"x": pose["x"], "y": pose["y"], "z": pose["z"]},
    )
    action = np.zeros(env.action_space.shape, dtype=np.float32)
    pose = env._root_pose_summary()  # noqa: SLF001
    pose["x"] = env._episode_start_x  # noqa: SLF001
    pose["y"] = env._episode_start_y  # noqa: SLF001
    pose["yaw"] = env._episode_start_yaw + 0.39  # noqa: SLF001
    env._last_locomotion_prior_residual = np.full(  # noqa: SLF001
        env.action_space.shape,
        0.4,
        dtype=np.float32,
    )
    env._last_locomotion_prior_residual_scale = 0.01  # noqa: SLF001

    env._reward(action, pose=pose, fell=False)  # noqa: SLF001

    assert env._last_reward_terms["no_progress"] == pytest.approx(-0.25)  # noqa: SLF001


def test_walk_reward_damps_velocity_credit_near_yaw_bound(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
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
    env._foot_contact_switch_count = 2  # noqa: SLF001
    monkeypatch.setattr(
        env,
        "_tracked_pose_summary",
        lambda pose: {"x": pose["x"], "y": pose["y"], "z": pose["z"]},
    )
    action = np.zeros(env.action_space.shape, dtype=np.float32)
    root_v = env._root_qvel_idx  # noqa: SLF001
    env._data.qvel[root_v] = 0.10  # noqa: SLF001
    stable_pose = env._root_pose_summary()  # noqa: SLF001
    stable_pose["x"] = env._episode_start_x + 0.12  # noqa: SLF001
    stable_pose["y"] = env._episode_start_y  # noqa: SLF001
    stable_pose["yaw"] = env._episode_start_yaw  # noqa: SLF001

    env._reward(action, pose=stable_pose, fell=False)  # noqa: SLF001
    stable_velocity = env._last_reward_terms["velocity_track"]  # noqa: SLF001

    yaw_pose = dict(stable_pose)
    yaw_pose["yaw"] = env._episode_start_yaw + 0.39  # noqa: SLF001
    env._reward(action, pose=yaw_pose, fell=False)  # noqa: SLF001

    assert stable_velocity > 0.0
    assert env._last_reward_terms["velocity_track"] < stable_velocity * 0.1  # noqa: SLF001


def test_walk_reward_penalizes_residual_near_yaw_guard(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=4,
            pca_dim=32,
            locomotion_action_prior="hiwonder_sine",
            locomotion_prior_residual_scale=0.25,
        ),
    )
    env.reset(seed=0)
    monkeypatch.setattr(
        env,
        "_tracked_pose_summary",
        lambda pose: {"x": pose["x"], "y": pose["y"], "z": pose["z"]},
    )
    action = np.zeros(env.action_space.shape, dtype=np.float32)
    pose = env._root_pose_summary()  # noqa: SLF001
    pose["x"] = env._episode_start_x + 0.05  # noqa: SLF001
    pose["y"] = env._episode_start_y  # noqa: SLF001
    pose["pitch"] = 0.0
    pose["roll"] = 0.0
    pose["yaw"] = env._episode_start_yaw + 0.35  # noqa: SLF001
    env._last_locomotion_prior_residual = np.full(  # noqa: SLF001
        env.action_space.shape,
        0.4,
        dtype=np.float32,
    )
    env._last_locomotion_prior_residual_pre_guard = np.full(  # noqa: SLF001
        env.action_space.shape,
        0.4,
        dtype=np.float32,
    )
    env._last_locomotion_prior_residual_scale = 0.25  # noqa: SLF001

    env._reward(action, pose=pose, fell=False)  # noqa: SLF001

    assert env._last_reward_terms["residual_energy"] < 0.0  # noqa: SLF001
    assert env._last_reward_terms["residual_yaw_guard"] < 0.0  # noqa: SLF001


def test_walk_reward_penalizes_guard_suppressed_residual(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=4,
            pca_dim=32,
            locomotion_action_prior="hiwonder_sine",
            locomotion_prior_residual_scale=0.25,
        ),
    )
    env.reset(seed=0)
    monkeypatch.setattr(
        env,
        "_tracked_pose_summary",
        lambda pose: {"x": pose["x"], "y": pose["y"], "z": pose["z"]},
    )
    pose = env._root_pose_summary()  # noqa: SLF001
    pose["x"] = env._episode_start_x + 0.05  # noqa: SLF001
    pose["y"] = env._episode_start_y  # noqa: SLF001
    pose["pitch"] = 0.0
    pose["roll"] = 0.0
    pose["yaw"] = env._episode_start_yaw  # noqa: SLF001
    env._last_locomotion_prior_residual_pre_guard = np.full(  # noqa: SLF001
        env.action_space.shape,
        0.4,
        dtype=np.float32,
    )
    env._last_locomotion_prior_residual = np.zeros(  # noqa: SLF001
        env.action_space.shape,
        dtype=np.float32,
    )
    env._last_locomotion_prior_residual_scale = 0.25  # noqa: SLF001

    env._reward(np.zeros(env.action_space.shape, dtype=np.float32), pose=pose, fell=False)  # noqa: SLF001

    assert env._last_reward_terms["residual_energy"] < 0.0  # noqa: SLF001
    assert env._last_reward_terms["residual_guard_suppression"] < 0.0  # noqa: SLF001


def test_walk_reward_does_not_penalize_noncausal_zero_scale_residual(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=4,
            pca_dim=32,
            locomotion_action_prior="hiwonder_sine",
            locomotion_prior_residual_scale=0.0,
        ),
    )
    env.reset(seed=0)
    monkeypatch.setattr(
        env,
        "_tracked_pose_summary",
        lambda pose: {"x": pose["x"], "y": pose["y"], "z": pose["z"]},
    )
    pose = env._root_pose_summary()  # noqa: SLF001
    pose["yaw"] = env._episode_start_yaw + 0.35  # noqa: SLF001
    env._last_locomotion_prior_residual = np.full(  # noqa: SLF001
        env.action_space.shape,
        0.4,
        dtype=np.float32,
    )
    env._last_locomotion_prior_residual_pre_guard = np.full(  # noqa: SLF001
        env.action_space.shape,
        0.4,
        dtype=np.float32,
    )
    env._last_locomotion_prior_residual_scale = 0.0  # noqa: SLF001

    env._reward(np.zeros(env.action_space.shape, dtype=np.float32), pose=pose, fell=False)  # noqa: SLF001

    assert env._last_reward_terms["residual_energy"] == 0.0  # noqa: SLF001
    assert env._last_reward_terms["residual_guard_suppression"] == 0.0  # noqa: SLF001
    assert env._last_reward_terms["residual_yaw_guard"] == 0.0  # noqa: SLF001


def test_walk_reward_penalizes_yaw_drift_before_hard_bound(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
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
    monkeypatch.setattr(
        env,
        "_tracked_pose_summary",
        lambda pose: {"x": pose["x"], "y": pose["y"], "z": pose["z"]},
    )
    action = np.zeros(env.action_space.shape, dtype=np.float32)
    pose = env._root_pose_summary()  # noqa: SLF001
    pose["x"] = env._episode_start_x + 0.15  # noqa: SLF001
    pose["y"] = env._episode_start_y  # noqa: SLF001
    straight = dict(pose)
    straight["yaw"] = env._episode_start_yaw  # noqa: SLF001
    yaw_drift = dict(straight)
    yaw_drift["yaw"] = env._episode_start_yaw + 0.35  # noqa: SLF001
    env._foot_contact_switch_count = 2  # noqa: SLF001

    assert env._reward(action, pose=straight, fell=False) > env._reward(  # noqa: SLF001
        action,
        pose=yaw_drift,
        fell=False,
    )


def test_profile_env_applies_profile_command_smoothing_and_slew_limit() -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            episode_steps=4,
            pca_dim=32,
            action_scale=1.0,
        ),
    )
    env.reset(seed=0)
    previous = env._command_target.copy()  # noqa: SLF001
    requested = previous + 1.0

    filtered = env._apply_profile_command_filter(requested)  # noqa: SLF001

    max_delta = env.profile.control.max_joint_delta_rad_per_step
    smoothing = env.profile.control.command_smoothing
    expected_delta = max_delta * (1.0 - smoothing)
    assert np.all(filtered - previous <= expected_delta + 1e-6)
    assert np.allclose(filtered, env._command_target)  # noqa: SLF001


def test_profile_env_applies_profile_force_limits_to_position_actuators() -> None:
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
    safe_clip = env.profile.control.safe_torque_clip_nm

    for aid, joint_torque in zip(
        env._profile_joint_actuator_idx,  # noqa: SLF001
        env._profile_joint_torque,  # noqa: SLF001
        strict=True,
    ):
        if aid < 0 or int(env._model.actuator_biastype[aid]) == 0:  # noqa: SLF001
            continue
        expected = min(float(safe_clip), float(joint_torque))
        assert int(env._model.actuator_forcelimited[aid]) == 1  # noqa: SLF001
        assert env._model.actuator_forcerange[aid].tolist() == pytest.approx(  # noqa: SLF001
            [-expected, expected]
        )


def test_hiwonder_stand_up_reset_uses_stable_sit_down_crouch() -> None:
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
    qpos_by_name = {
        joint.name: float(env._data.qpos[qpos_idx])  # noqa: SLF001
        for joint, qpos_idx in zip(
            env.profile.kinematics.joints,
            env._profile_joint_qpos_idx,  # noqa: SLF001
            strict=True,
        )
    }

    assert qpos_by_name["l_hip_pitch"] == pytest.approx(qpos_by_name["r_hip_pitch"])
    assert qpos_by_name["l_knee"] == pytest.approx(qpos_by_name["r_knee"])
    assert qpos_by_name["l_ank_pitch"] == pytest.approx(qpos_by_name["r_ank_pitch"])
    assert qpos_by_name["l_hip_pitch"] == pytest.approx(-0.8)
    assert qpos_by_name["l_knee"] == pytest.approx(1.6)
    assert qpos_by_name["l_ank_pitch"] == pytest.approx(0.8)


def test_walk_velocity_reward_uses_body_frame_velocity() -> None:
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
    env._data.qvel[root_v + 1] = 0.0  # noqa: SLF001

    aligned_pose = env._root_pose_summary()  # noqa: SLF001
    aligned_pose["yaw"] = env._episode_start_yaw  # noqa: SLF001
    sideways_pose = dict(aligned_pose)
    sideways_pose["yaw"] = math.pi / 2.0

    aligned_reward = env._reward(action, pose=aligned_pose, fell=False)  # noqa: SLF001
    sideways_reward = env._reward(action, pose=sideways_pose, fell=False)  # noqa: SLF001

    assert aligned_reward > sideways_reward + 3.0


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
    no_delta_pose["z"] = env._stand_height_m * 0.95  # noqa: SLF001
    env._episode_start_torso_z = no_delta_pose["z"] - env._stand_height_m * 0.10  # noqa: SLF001
    stood_pose = dict(no_delta_pose)
    stood_pose["z"] = env._episode_start_torso_z + env._stand_height_m * 0.13  # noqa: SLF001

    assert env._immediate_success_predicate_holds(no_delta_pose) is False  # noqa: SLF001
    assert env._immediate_success_predicate_holds(stood_pose) is True  # noqa: SLF001
    assert env._reward(action, pose=stood_pose, fell=False) > env._reward(  # noqa: SLF001
        action,
        pose=no_delta_pose,
        fell=False,
    ) + 6.0


def test_get_up_height_without_upright_pose_does_not_get_success_bonus() -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("get_up",),
            exclude_tasks=(),
            tier_subset=(2,),
            episode_steps=4,
            pca_dim=32,
        ),
    )
    env.reset(seed=0)
    pose = env._root_pose_summary()  # noqa: SLF001
    pose["z"] = env._stand_height_m  # noqa: SLF001
    pose["roll"] = 0.7
    pose["pitch"] = 0.0
    pose["upright_proj"] = 1.0

    assert env._immediate_success_predicate_holds(pose) is False  # noqa: SLF001


def test_turn_around_success_requires_translation_bound(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("turn_around",),
            exclude_tasks=(),
            episode_steps=4,
            pca_dim=32,
        ),
    )
    env.reset(seed=0)
    monkeypatch.setattr(
        env,
        "_tracked_pose_summary",
        lambda pose: {"x": pose["x"], "y": pose["y"], "z": pose["z"]},
    )
    pose = env._root_pose_summary()  # noqa: SLF001
    pose["yaw"] = env._episode_start_yaw + math.pi  # noqa: SLF001
    pose["x"] = env._episode_start_x + 0.5  # noqa: SLF001
    pose["y"] = env._episode_start_y  # noqa: SLF001

    assert env._immediate_success_predicate_holds(pose) is False  # noqa: SLF001


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
    env._step_count = 1  # noqa: SLF001
    early_fall = env._reward(action, pose=fallen_pose, fell=True)  # noqa: SLF001
    env._step_count = env.config.episode_steps  # noqa: SLF001
    horizon_end_fall = env._reward(action, pose=fallen_pose, fell=True)  # noqa: SLF001
    assert early_fall < horizon_end_fall - 10.0

    env._step_count = 0  # noqa: SLF001
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
