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

    ok = checker.update(
        TelemetrySample(
            t_s=1.2,
            torso_x_m=0.35,
            torso_y_m=0.0,
            torso_z_m=0.27,
            extra={"stand_height_m": 0.27},
        )
    )
    assert ok.success is True
    assert "Δx" in ok.reason
    assert "Δy" in ok.reason


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


@pytest.mark.parametrize("profile_id", ("hiwonder-ainex", "asimov-1", "unitree-g1", "unitree-h1", "unitree-r1"))
def test_stand_up_starts_below_profile_stand_height_without_immediate_fall(profile_id: str) -> None:
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
