"""Tests for BraxTargetSkill — target-reaching deployment skill."""

from __future__ import annotations

import math

import numpy as np
import pytest

from eliza_robot.rl.skills.base import SkillParams, SkillStatus
from eliza_robot.rl.skills.brax_target_skill import (
    FALLBACK_VX_MAX,
    FALLBACK_VYAW_GAIN,
    FALLBACK_VYAW_MAX,
    NUM_LEG_JOINTS,
    BraxTargetSkill,
)
from eliza_robot.rl.skills.registry import SkillRegistry


@pytest.fixture
def skill() -> BraxTargetSkill:
    """Create a BraxTargetSkill in fallback mode (no checkpoint)."""
    return BraxTargetSkill(checkpoint_path="/nonexistent/checkpoint")


# ---------------------------------------------------------------------------
# Init / fallback mode
# ---------------------------------------------------------------------------

class TestInit:
    def test_init_no_checkpoint_uses_fallback(self, skill: BraxTargetSkill) -> None:
        assert skill.using_fallback is True
        assert skill.is_loaded is False
        assert skill._fallback_walk is not None

    def test_name(self, skill: BraxTargetSkill) -> None:
        assert skill.name == "walk_to_target"

    def test_action_dim(self, skill: BraxTargetSkill) -> None:
        assert skill.action_dim == 12

    def test_requires_rl(self, skill: BraxTargetSkill) -> None:
        assert skill.requires_rl is True


class TestFirstFrameNoSpike:
    def test_last_positions_equals_default_after_reset(self):
        skill = BraxTargetSkill()
        skill.reset()
        np.testing.assert_array_equal(skill._last_positions, skill._default_pose)

    def test_first_finite_diff_is_zero(self):
        skill = BraxTargetSkill()
        skill.reset()
        pos = skill._default_pose.copy()
        vel = (pos - skill._last_positions) * 2.5
        np.testing.assert_allclose(vel, 0.0, atol=1e-10)


class TestSetTarget:
    def test_set_target_stores_values(self, skill: BraxTargetSkill) -> None:
        skill.set_target(x=1.5, y=0.3)
        assert skill._target_x == pytest.approx(1.5)
        assert skill._target_y == pytest.approx(0.3)
        assert skill._target_set is True

    def test_set_target_updates_distance(self, skill: BraxTargetSkill) -> None:
        skill.set_target(x=3.0, y=4.0)
        assert skill.target_distance == pytest.approx(5.0)

    def test_set_target_updates_bearing(self, skill: BraxTargetSkill) -> None:
        skill.set_target(x=1.0, y=0.0)
        assert skill.target_bearing == pytest.approx(0.0)

        skill.set_target(x=0.0, y=1.0)
        assert skill.target_bearing == pytest.approx(math.pi / 2)

    def test_set_target_zero(self, skill: BraxTargetSkill) -> None:
        skill.set_target(x=0.0, y=0.0)
        assert skill.target_distance == pytest.approx(0.0)


class TestSetTargetWorld:
    def test_convert_world_to_body_straight_ahead(
        self, skill: BraxTargetSkill
    ) -> None:
        target_world = np.array([3.0, 0.0])
        robot_pos = np.array([1.0, 0.0])
        robot_yaw = 0.0

        skill.set_target_world(target_world, robot_pos, robot_yaw)

        assert skill._target_x == pytest.approx(2.0, abs=1e-6)
        assert skill._target_y == pytest.approx(0.0, abs=1e-6)

    def test_convert_world_to_body_rotated_90(
        self, skill: BraxTargetSkill
    ) -> None:
        target_world = np.array([3.0, 0.0])
        robot_pos = np.array([1.0, 0.0])
        robot_yaw = math.pi / 2

        skill.set_target_world(target_world, robot_pos, robot_yaw)

        assert skill._target_x == pytest.approx(0.0, abs=1e-6)
        assert skill._target_y == pytest.approx(-2.0, abs=1e-6)

    def test_convert_world_to_body_3d_input(
        self, skill: BraxTargetSkill
    ) -> None:
        target_world = np.array([5.0, 5.0, 0.0])
        robot_pos = np.array([5.0, 3.0, 0.0])
        robot_yaw = 0.0

        skill.set_target_world(target_world, robot_pos, robot_yaw)

        assert skill._target_x == pytest.approx(0.0, abs=1e-6)
        assert skill._target_y == pytest.approx(2.0, abs=1e-6)


class TestFallbackVelocity:
    def test_vx_proportional_to_distance(self, skill: BraxTargetSkill) -> None:
        skill.set_target(x=0.15, y=0.0)
        vx, _ = skill._compute_fallback_velocity()
        assert vx == pytest.approx(0.15, abs=1e-6)

    def test_vx_clamped_at_max(self, skill: BraxTargetSkill) -> None:
        skill.set_target(x=10.0, y=0.0)
        vx, _ = skill._compute_fallback_velocity()
        assert vx == pytest.approx(FALLBACK_VX_MAX)

    def test_vx_zero_when_at_target(self, skill: BraxTargetSkill) -> None:
        skill.set_target(x=0.0, y=0.0)
        vx, _ = skill._compute_fallback_velocity()
        assert vx == pytest.approx(0.0)

    def test_vyaw_proportional_to_bearing(
        self, skill: BraxTargetSkill
    ) -> None:
        skill.set_target(x=1.0, y=1.0)
        _, vyaw = skill._compute_fallback_velocity()
        expected_bearing = math.atan2(1.0, 1.0)
        expected_vyaw = float(np.clip(
            expected_bearing * FALLBACK_VYAW_GAIN,
            -FALLBACK_VYAW_MAX,
            FALLBACK_VYAW_MAX,
        ))
        assert vyaw == pytest.approx(expected_vyaw, abs=1e-6)

    def test_vyaw_clamped(self, skill: BraxTargetSkill) -> None:
        skill.set_target(x=0.001, y=10.0)
        _, vyaw = skill._compute_fallback_velocity()
        assert abs(vyaw) <= FALLBACK_VYAW_MAX + 1e-9


class TestTargetReached:
    def test_reached_when_within_threshold(
        self, skill: BraxTargetSkill
    ) -> None:
        skill.set_target(x=0.1, y=0.1)
        assert skill.target_reached is True

    def test_not_reached_when_outside_threshold(
        self, skill: BraxTargetSkill
    ) -> None:
        skill.set_target(x=1.0, y=1.0)
        assert skill.target_reached is False

    def test_custom_threshold(self) -> None:
        skill = BraxTargetSkill(
            checkpoint_path="/nonexistent", arrival_threshold=2.0
        )
        skill.set_target(x=1.0, y=1.0)
        assert skill.target_reached is True


class TestGetActionFromTelemetry:
    def test_returns_12_dim_output(self, skill: BraxTargetSkill) -> None:
        skill.set_target(x=1.0, y=0.0)
        action, status = skill.get_action_from_telemetry(
            imu_roll=0.0,
            imu_pitch=0.0,
            joint_positions=np.zeros(NUM_LEG_JOINTS, dtype=np.float32),
        )
        assert action.shape == (NUM_LEG_JOINTS,)
        assert status == SkillStatus.RUNNING

    def test_returns_completed_when_target_reached(
        self, skill: BraxTargetSkill
    ) -> None:
        skill.set_target(x=0.1, y=0.0)
        _, status = skill.get_action_from_telemetry()
        assert status == SkillStatus.COMPLETED

    def test_returns_completed_on_duration_expired(self) -> None:
        skill = BraxTargetSkill(checkpoint_path="/nonexistent")
        skill.reset(SkillParams(duration_sec=0.02))
        skill.set_target(x=5.0, y=0.0)
        _, status = skill.get_action_from_telemetry()
        assert status == SkillStatus.COMPLETED


class TestGetAction:
    def test_returns_12_dim_output(self, skill: BraxTargetSkill) -> None:
        skill.set_target(x=2.0, y=0.0)
        obs = np.zeros(135, dtype=np.float32)
        action, _status = skill.get_action(obs)
        assert action.shape == (NUM_LEG_JOINTS,)

    def test_default_pose_returned_when_target_reached(
        self, skill: BraxTargetSkill
    ) -> None:
        skill.set_target(x=0.05, y=0.0)
        obs = np.zeros(135, dtype=np.float32)
        action, status = skill.get_action(obs)
        assert status == SkillStatus.COMPLETED
        np.testing.assert_array_almost_equal(action, skill.default_pose)


class TestReset:
    def test_reset_clears_target(self, skill: BraxTargetSkill) -> None:
        skill.set_target(x=1.0, y=2.0)
        skill.reset()
        assert skill._target_set is False
        assert skill._target_x == 0.0
        assert skill._target_y == 0.0

    def test_reset_clears_step_counter(self, skill: BraxTargetSkill) -> None:
        skill.set_target(x=5.0, y=0.0)
        skill.get_action_from_telemetry()
        skill.get_action_from_telemetry()
        assert skill._step == 2
        skill.reset()
        assert skill._step == 0


class TestRegistryAliases:
    def test_walk_to_target_alias(self) -> None:
        registry = SkillRegistry()
        skill = BraxTargetSkill(checkpoint_path="/nonexistent")
        registry.register(skill)
        assert registry.get("walk to target") is skill

    def test_go_to_alias(self) -> None:
        registry = SkillRegistry()
        skill = BraxTargetSkill(checkpoint_path="/nonexistent")
        registry.register(skill)
        assert registry.get("go to") is skill

    def test_navigate_to_alias(self) -> None:
        registry = SkillRegistry()
        skill = BraxTargetSkill(checkpoint_path="/nonexistent")
        registry.register(skill)
        assert registry.get("navigate to") is skill

    def test_approach_alias(self) -> None:
        registry = SkillRegistry()
        skill = BraxTargetSkill(checkpoint_path="/nonexistent")
        registry.register(skill)
        assert registry.get("approach") is skill

    def test_direct_name_lookup(self) -> None:
        registry = SkillRegistry()
        skill = BraxTargetSkill(checkpoint_path="/nonexistent")
        registry.register(skill)
        assert registry.get("walk_to_target") is skill
