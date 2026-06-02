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


def _stand_extra(*, left: bool = True, right: bool = False) -> dict[str, object]:
    return {
        "stand_height_m": 0.27,
        "left_foot_contact": left,
        "right_foot_contact": right,
        "left_foot_z_m": 0.0 if left else 0.03,
        "right_foot_z_m": 0.0 if right else 0.03,
        "left_foot_slip_m_s": 0.02,
        "right_foot_slip_m_s": 0.02,
        "self_collision_count": 0,
    }


def test_walk_forward_requires_height_forward_motion_and_lateral_bound() -> None:
    checker = _checker("walk_forward")
    checker.update(
        TelemetrySample(
            t_s=0.0,
            torso_x_m=0.0,
            torso_y_m=0.0,
            torso_z_m=0.27,
            yaw_rad=0.0,
            extra=_stand_extra(left=True, right=False),
        )
    )

    low = checker.update(
        TelemetrySample(
            t_s=1.0,
            torso_x_m=0.35,
            torso_y_m=0.0,
            torso_z_m=0.05,
            extra=_stand_extra(left=False, right=True),
        )
    )
    assert low.success is False

    drift = checker.update(
        TelemetrySample(
            t_s=1.1,
            torso_x_m=0.35,
            torso_y_m=0.25,
            torso_z_m=0.27,
            extra=_stand_extra(left=True, right=False),
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
            extra=_stand_extra(left=False, right=True),
        )
    )
    assert yaw_drift.success is False

    holding = checker.update(
        TelemetrySample(
            t_s=1.2,
            torso_x_m=0.35,
            torso_y_m=0.0,
            torso_z_m=0.27,
            yaw_rad=0.1,
            extra=_stand_extra(left=True, right=False),
        )
    )
    assert holding.success is False
    ok = checker.update(
        TelemetrySample(
            t_s=2.3,
            torso_x_m=0.35,
            torso_y_m=0.0,
            torso_z_m=0.27,
            yaw_rad=0.1,
            extra=_stand_extra(left=False, right=True),
        )
    )
    assert ok.success is True
    assert "Δx" in ok.reason
    assert "Δy" in ok.reason
    assert "foot_contact_switches" in ok.reason


def test_walk_forward_rejects_sliding_without_alternating_foot_contacts() -> None:
    checker = _checker("walk_forward")
    result = None
    for t_s in (0.0, 1.2, 2.3):
        result = checker.update(
            TelemetrySample(
                t_s=t_s,
                torso_x_m=0.35,
                torso_y_m=0.0,
                torso_z_m=0.27,
                yaw_rad=0.1,
                extra=_stand_extra(left=True, right=True),
            )
        )

    assert result is not None
    assert result.success is False


@pytest.mark.parametrize(
    ("extra", "reason"),
    (
        (
            {
                "left_foot_z_m": 0.0,
                "right_foot_z_m": 0.0,
            },
            "dragging swing feet",
        ),
        (
            {
                "left_foot_slip_m_s": 0.8,
                "right_foot_slip_m_s": 0.8,
            },
            "slipping stance feet",
        ),
        (
            {
                "self_collision_count": 1,
            },
            "self collision",
        ),
    ),
)
def test_walk_forward_requires_clear_non_slipping_non_colliding_steps(
    extra: dict[str, object],
    reason: str,
) -> None:
    checker = _checker("walk_forward")
    result = None
    for t_s, left in ((0.0, True), (1.0, False), (1.5, True), (2.6, False)):
        result = checker.update(
            TelemetrySample(
                t_s=t_s,
                torso_x_m=0.35 if t_s > 0.0 else 0.0,
                torso_y_m=0.0,
                torso_z_m=0.27,
                yaw_rad=0.0,
                extra={**_stand_extra(left=left, right=not left), **extra},
            )
        )

    assert result is not None, reason
    assert result.success is False, reason


def test_walk_forward_uses_tracked_motion_without_overloading_torso_height() -> None:
    checker = _checker("walk_forward")
    checker.update(
        TelemetrySample(
            t_s=0.0,
            torso_x_m=0.0,
            torso_y_m=0.0,
            torso_z_m=0.24,
            yaw_rad=0.0,
            extra={
                **_stand_extra(left=True, right=False),
                "tracked_x_m": 0.0,
                "tracked_y_m": 0.0,
                "tracked_z_m": 0.40,
            },
        )
    )
    checker.update(
        TelemetrySample(
            t_s=1.0,
            torso_x_m=0.0,
            torso_y_m=0.0,
            torso_z_m=0.24,
            yaw_rad=0.0,
            extra={
                **_stand_extra(left=False, right=True),
                "tracked_x_m": 0.35,
                "tracked_y_m": 0.0,
                "tracked_z_m": 0.41,
            },
        )
    )
    checker.update(
        TelemetrySample(
            t_s=1.5,
            torso_x_m=0.0,
            torso_y_m=0.0,
            torso_z_m=0.24,
            yaw_rad=0.0,
            extra={
                **_stand_extra(left=True, right=False),
                "tracked_x_m": 0.36,
                "tracked_y_m": 0.0,
                "tracked_z_m": 0.41,
            },
        )
    )
    result = checker.update(
        TelemetrySample(
            t_s=2.6,
            torso_x_m=0.0,
            torso_y_m=0.0,
            torso_z_m=0.24,
            yaw_rad=0.0,
            extra={
                **_stand_extra(left=False, right=True),
                "tracked_x_m": 0.36,
                "tracked_y_m": 0.0,
                "tracked_z_m": 0.41,
            },
        )
    )

    assert result.success is True


def test_walking_curriculum_declares_staged_biped_reward_terms() -> None:
    curriculum = load_curriculum()

    for task_id in (
        "walk_forward",
        "walk_backward",
        "sidestep_left",
        "sidestep_right",
    ):
        task = curriculum.by_id(task_id)
        assert task.reward["stance_contact_weight"] > 0.0
        assert task.reward["foot_clearance_weight"] > 0.0
        assert task.reward["alternating_contact_weight"] > 0.0
        assert task.success["min_alternating_foot_contacts"] >= 2
        assert task.success["min_swing_foot_clearance_m"] > 0.0


def test_walking_curriculum_declares_pre_walk_single_support_tasks() -> None:
    curriculum = load_curriculum()

    staged = {
        "weight_shift_left": (True, False, False),
        "weight_shift_right": (False, True, False),
        "lift_left_foot": (False, True, True),
        "lift_right_foot": (True, False, True),
    }
    for task_id, (left_contact, right_contact, requires_clearance) in staged.items():
        task = curriculum.by_id(task_id)
        assert task.success["left_foot_contact_required"] is left_contact
        assert task.success["right_foot_contact_required"] is right_contact
        assert task.success["torso_z_min_ratio"] >= 0.75
        assert task.success["max_abs_delta_x_m"] <= 0.08
        assert task.success["max_abs_delta_yaw_rad"] <= 0.25
        assert task.reward["stance_contact_weight"] > 0.0
        assert task.reward["foot_clearance_weight"] > 0.0
        if requires_clearance:
            assert task.success["min_swing_foot_clearance_m"] > 0.0

    step = curriculum.by_id("step_in_place")
    assert step.success["min_alternating_foot_contacts"] >= 2
    assert step.success["min_swing_foot_clearance_m"] > 0.0
    assert step.success["max_abs_delta_x_m"] <= 0.08
    assert step.success["max_abs_delta_y_m"] <= 0.08


def test_lift_left_foot_goal_requires_right_plant_left_swing_clearance() -> None:
    checker = _checker("lift_left_foot")
    checker.update(
        TelemetrySample(
            t_s=0.0,
            torso_x_m=0.0,
            torso_y_m=0.0,
            torso_z_m=0.27,
            yaw_rad=0.0,
            extra=_stand_extra(left=True, right=True),
        )
    )
    wrong_contact = checker.update(
        TelemetrySample(
            t_s=0.5,
            torso_x_m=0.0,
            torso_y_m=0.0,
            torso_z_m=0.27,
            yaw_rad=0.0,
            extra=_stand_extra(left=True, right=True),
        )
    )
    assert wrong_contact.success is False

    low_clearance = checker.update(
        TelemetrySample(
            t_s=0.6,
            torso_x_m=0.0,
            torso_y_m=0.0,
            torso_z_m=0.27,
            yaw_rad=0.0,
            extra={
                **_stand_extra(left=False, right=True),
                "left_foot_z_m": 0.005,
            },
        )
    )
    assert low_clearance.success is False

    holding = checker.update(
        TelemetrySample(
            t_s=0.7,
            torso_x_m=0.0,
            torso_y_m=0.0,
            torso_z_m=0.27,
            yaw_rad=0.0,
            extra={
                **_stand_extra(left=False, right=True),
                "left_foot_z_m": 0.02,
            },
        )
    )
    assert holding.success is False

    ok = checker.update(
        TelemetrySample(
            t_s=1.2,
            torso_x_m=0.0,
            torso_y_m=0.0,
            torso_z_m=0.27,
            yaw_rad=0.0,
            extra={
                **_stand_extra(left=False, right=True),
                "left_foot_z_m": 0.02,
            },
        )
    )
    assert ok.success is True
    assert "left_foot_contact=False" in ok.reason
    assert "right_foot_contact=True" in ok.reason
    assert "swing_clearance" in ok.reason


def test_sidestep_requires_lateral_motion_without_forward_or_yaw_drift() -> None:
    checker = _checker("sidestep_left")
    checker.update(
        TelemetrySample(
            t_s=0.0,
            torso_x_m=0.0,
            torso_y_m=0.0,
            torso_z_m=0.27,
            yaw_rad=0.0,
            extra=_stand_extra(left=True, right=False),
        )
    )
    forward_drift = checker.update(
        TelemetrySample(
            t_s=1.0,
            torso_x_m=0.25,
            torso_y_m=0.25,
            torso_z_m=0.27,
            yaw_rad=0.0,
            extra=_stand_extra(left=False, right=True),
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
            extra=_stand_extra(left=True, right=False),
        )
    )
    assert yaw_drift.success is False

    holding = checker.update(
        TelemetrySample(
            t_s=1.2,
            torso_x_m=0.05,
            torso_y_m=0.25,
            torso_z_m=0.27,
            yaw_rad=0.1,
            extra=_stand_extra(left=False, right=True),
        )
    )
    assert holding.success is False
    ok = checker.update(
        TelemetrySample(
            t_s=2.3,
            torso_x_m=0.05,
            torso_y_m=0.25,
            torso_z_m=0.27,
            yaw_rad=0.1,
            extra=_stand_extra(left=True, right=False),
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

    holding = checker.update(
        TelemetrySample(
            t_s=1.1,
            torso_x_m=0.05,
            torso_y_m=0.02,
            torso_z_m=0.27,
            yaw_rad=0.8,
            extra={"stand_height_m": 0.27},
        )
    )
    assert holding.success is False
    ok = checker.update(
        TelemetrySample(
            t_s=2.2,
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
            domain_rand=False,
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

    result = None
    for t_s in np.linspace(0.2, task.success["hold_s"] + 0.4, num=12):
        result = checker.update(
            TelemetrySample(
                t_s=float(t_s),
                torso_x_m=env._episode_start_x,  # noqa: SLF001
                torso_y_m=env._episode_start_y,  # noqa: SLF001
                torso_z_m=env._stand_height_m,  # noqa: SLF001
                yaw_rad=env._episode_start_yaw,  # noqa: SLF001
                extra={"stand_height_m": env._stand_height_m},  # noqa: SLF001
            )
        )

    assert result is not None
    assert result.success is True
