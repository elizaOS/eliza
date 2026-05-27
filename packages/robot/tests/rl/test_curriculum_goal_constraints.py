from __future__ import annotations

import numpy as np
import pytest

from eliza_robot.curriculum.goal_checker import GoalChecker, TelemetrySample
from eliza_robot.curriculum.loader import load_curriculum
from eliza_robot.rl.text_conditioned.profile_env import (
    ProfileEnvConfig,
    make_text_conditioned_env,
)
from scripts.interactive_viewer import _resolve_task_id, _scripted_smoke_action


def _checker(task_id: str) -> GoalChecker:
    return GoalChecker(load_curriculum().by_id(task_id), episode_start_t_s=0.0)


def test_walk_forward_requires_height_forward_motion_and_lateral_bound() -> None:
    checker = _checker("walk_forward")
    checker.update(
        TelemetrySample(
            t_s=0.0,
            torso_x_m=0.0,
            torso_y_m=0.0,
            torso_z_m=0.27,
            yaw_rad=0.0,
            extra={"stand_height_m": 0.27},
        )
    )

    low = checker.update(
        TelemetrySample(
            t_s=1.0,
            torso_x_m=0.35,
            torso_y_m=0.0,
            torso_z_m=0.05,
            extra={"stand_height_m": 0.27},
        )
    )
    assert low.success is False

    drift = checker.update(
        TelemetrySample(
            t_s=1.1,
            torso_x_m=0.35,
            torso_y_m=0.25,
            torso_z_m=0.27,
            extra={"stand_height_m": 0.27},
        )
    )
    assert drift.success is False

    yaw_drift = checker.update(
        TelemetrySample(
            t_s=1.15,
            torso_x_m=0.35,
            torso_y_m=0.0,
            torso_z_m=0.27,
            yaw_rad=0.5,
            extra={"stand_height_m": 0.27},
        )
    )
    assert yaw_drift.success is False

    ok = checker.update(
        TelemetrySample(
            t_s=1.2,
            torso_x_m=0.35,
            torso_y_m=0.0,
            torso_z_m=0.27,
            yaw_rad=0.1,
            extra={"stand_height_m": 0.27},
        )
    )
    assert ok.success is True
    assert "Δx" in ok.reason
    assert "Δy" in ok.reason


def test_sidestep_requires_lateral_motion_without_forward_or_yaw_drift() -> None:
    checker = _checker("sidestep_left")
    checker.update(
        TelemetrySample(
            t_s=0.0,
            torso_x_m=0.0,
            torso_y_m=0.0,
            torso_z_m=0.27,
            yaw_rad=0.0,
            extra={"stand_height_m": 0.27},
        )
    )
    forward_drift = checker.update(
        TelemetrySample(
            t_s=1.0,
            torso_x_m=0.25,
            torso_y_m=0.25,
            torso_z_m=0.27,
            yaw_rad=0.0,
            extra={"stand_height_m": 0.27},
        )
    )
    assert forward_drift.success is False

    yaw_drift = checker.update(
        TelemetrySample(
            t_s=1.1,
            torso_x_m=0.0,
            torso_y_m=0.25,
            torso_z_m=0.27,
            yaw_rad=0.5,
            extra={"stand_height_m": 0.27},
        )
    )
    assert yaw_drift.success is False

    ok = checker.update(
        TelemetrySample(
            t_s=1.2,
            torso_x_m=0.05,
            torso_y_m=0.25,
            torso_z_m=0.27,
            yaw_rad=0.1,
            extra={"stand_height_m": 0.27},
        )
    )
    assert ok.success is True
    assert "Δy" in ok.reason
    assert "Δx" in ok.reason


def test_turn_left_requires_yaw_without_translation_drift() -> None:
    checker = _checker("turn_left")
    checker.update(
        TelemetrySample(
            t_s=0.0,
            torso_x_m=0.0,
            torso_y_m=0.0,
            torso_z_m=0.27,
            yaw_rad=0.0,
            extra={"stand_height_m": 0.27},
        )
    )
    drift = checker.update(
        TelemetrySample(
            t_s=1.0,
            torso_x_m=0.3,
            torso_y_m=0.1,
            torso_z_m=0.27,
            yaw_rad=0.8,
            extra={"stand_height_m": 0.27},
        )
    )
    assert drift.success is False

    ok = checker.update(
        TelemetrySample(
            t_s=1.1,
            torso_x_m=0.05,
            torso_y_m=0.02,
            torso_z_m=0.27,
            yaw_rad=0.8,
            extra={"stand_height_m": 0.27},
        )
    )
    assert ok.success is True
    assert "xy_drift" in ok.reason


def test_sit_down_requires_low_height_without_translation_or_yaw_drift() -> None:
    checker = _checker("sit_down")
    checker.update(
        TelemetrySample(
            t_s=0.0,
            torso_x_m=0.0,
            torso_y_m=0.0,
            torso_z_m=0.27,
            yaw_rad=0.0,
        )
    )
    moving_sit = checker.update(
        TelemetrySample(
            t_s=1.1,
            torso_x_m=0.2,
            torso_y_m=0.0,
            torso_z_m=0.16,
            yaw_rad=0.0,
        )
    )
    assert moving_sit.success is False

    spinning_sit = checker.update(
        TelemetrySample(
            t_s=1.2,
            torso_x_m=0.0,
            torso_y_m=0.0,
            torso_z_m=0.16,
            yaw_rad=0.5,
        )
    )
    assert spinning_sit.success is False

    holding = checker.update(
        TelemetrySample(
            t_s=1.3,
            torso_x_m=0.02,
            torso_y_m=0.01,
            torso_z_m=0.16,
            yaw_rad=0.1,
        )
    )
    assert holding.success is False

    ok = checker.update(
        TelemetrySample(
            t_s=2.4,
            torso_x_m=0.02,
            torso_y_m=0.01,
            torso_z_m=0.16,
            yaw_rad=0.1,
        )
    )
    assert ok.success is True


def test_motion_success_windows_apply_to_y_and_yaw_predicates() -> None:
    sidestep = _checker("sidestep_left")
    sidestep.update(
        TelemetrySample(
            t_s=0.0,
            torso_x_m=0.0,
            torso_y_m=0.0,
            torso_z_m=0.27,
            yaw_rad=0.0,
            extra={"stand_height_m": 0.27},
        )
    )
    late_side = sidestep.update(
        TelemetrySample(
            t_s=6.0,
            torso_x_m=0.0,
            torso_y_m=0.25,
            torso_z_m=0.27,
            yaw_rad=0.0,
            extra={"stand_height_m": 0.27},
        )
    )
    assert late_side.success is False

    turn = _checker("turn_left")
    turn.update(
        TelemetrySample(
            t_s=0.0,
            torso_x_m=0.0,
            torso_y_m=0.0,
            torso_z_m=0.27,
            yaw_rad=0.0,
            extra={"stand_height_m": 0.27},
        )
    )
    late_turn = turn.update(
        TelemetrySample(
            t_s=5.0,
            torso_x_m=0.0,
            torso_y_m=0.0,
            torso_z_m=0.27,
            yaw_rad=0.8,
            extra={"stand_height_m": 0.27},
        )
    )
    assert late_turn.success is False


def test_stand_up_ratio_success_needs_profile_stand_height() -> None:
    checker = _checker("stand_up")
    checker.update(TelemetrySample(t_s=0.0, torso_z_m=0.16))

    missing_profile_height = checker.update(TelemetrySample(t_s=1.0, torso_z_m=0.27))
    assert missing_profile_height.success is False

    holding = checker.update(
        TelemetrySample(
            t_s=1.1,
            torso_z_m=0.27,
            extra={"stand_height_m": 0.27},
        )
    )
    assert holding.success is False
    ok = checker.update(
        TelemetrySample(
            t_s=3.2,
            torso_z_m=0.27,
            extra={"stand_height_m": 0.27},
        )
    )
    assert ok.success is True


def test_stand_up_height_threshold_alone_does_not_pass() -> None:
    checker = _checker("stand_up")
    checker.update(
        TelemetrySample(
            t_s=0.0,
            torso_z_m=0.245,
            extra={"stand_height_m": 0.27},
        )
    )
    result = checker.update(
        TelemetrySample(
            t_s=3.0,
            torso_z_m=0.246,
            extra={"stand_height_m": 0.27},
        )
    )
    assert result.success is False


def test_wave_left_height_alone_does_not_pass() -> None:
    checker = _checker("wave_left")
    checker.update(TelemetrySample(t_s=0.0, torso_z_m=0.27))
    result = checker.update(TelemetrySample(t_s=3.0, torso_z_m=0.27))
    assert result.success is False


def test_interactive_viewer_resolves_text_variants() -> None:
    curriculum = load_curriculum()
    assert _resolve_task_id("go forward", curriculum.all_ids(), curriculum) == "walk_forward"


def test_scripted_smoke_attempts_nonzero_motion() -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            pca_dim=32,
            episode_steps=4,
        ),
    )
    env.reset(seed=0)
    action = _scripted_smoke_action(env, "walk_forward", 3)
    assert action.shape == env.action_space.shape
    assert float(np.linalg.norm(action)) > 0.0


@pytest.mark.parametrize(
    "profile_id",
    ("hiwonder-ainex", "asimov-1", "unitree-g1", "unitree-h1", "unitree-r1"),
)
def test_stand_up_starts_below_profile_stand_height_without_immediate_fall(
    profile_id: str,
) -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        profile_id,
        config=ProfileEnvConfig(
            include_tasks=("stand_up",),
            exclude_tasks=(),
            pca_dim=32,
            episode_steps=4,
        ),
    )
    env.reset(seed=0)
    assert env._episode_start_torso_z < env._stand_height_m  # noqa: SLF001

    _, _, terminated, _, info = env.step(np.zeros(env.action_space.shape, dtype=np.float32))
    assert terminated is False
    assert info["fall_threshold"] <= info["init_torso_z"]


def test_hiwonder_stand_up_goal_is_attainable_from_curriculum_reset() -> None:
    pytest.importorskip("mujoco")
    env = make_text_conditioned_env(
        "hiwonder-ainex",
        config=ProfileEnvConfig(
            include_tasks=("stand_up",),
            exclude_tasks=(),
            pca_dim=32,
            episode_steps=160,
        ),
    )
    env.reset(seed=0)
    task = load_curriculum().by_id("stand_up")
    checker = GoalChecker(task, episode_start_t_s=0.0)
    checker.update(
        TelemetrySample(
            t_s=0.0,
            torso_x_m=env._episode_start_x,  # noqa: SLF001
            torso_y_m=env._episode_start_y,  # noqa: SLF001
            torso_z_m=env._episode_start_torso_z,  # noqa: SLF001
            yaw_rad=env._episode_start_yaw,  # noqa: SLF001
            extra={"stand_height_m": env._stand_height_m},  # noqa: SLF001
        )
    )

    action = np.zeros(env.action_space.shape, dtype=np.float32)
    for idx, joint in enumerate(env._action_joints):  # noqa: SLF001
        if "hip_pitch" in joint.name:
            action[idx] = -1.0
        elif "knee" in joint.name:
            action[idx] = 1.0
        elif "ank_pitch" in joint.name:
            action[idx] = -1.0

    result = None
    for step in range(160):
        _, _, terminated, truncated, info = env.step(action)
        result = checker.update(
            TelemetrySample(
                t_s=(step + 1) * env.config.control_dt_s,
                torso_x_m=info["root_x"],
                torso_y_m=info["root_y"],
                torso_z_m=info["torso_z"],
                yaw_rad=info["root_yaw"],
                extra={"stand_height_m": info["stand_height_m"]},
            )
        )
        if result.success or result.failed or terminated or truncated:
            break

    assert result is not None
    assert result.success is True
    assert terminated is False
