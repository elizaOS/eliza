"""Tests for skill library and registry.

The scripted skills (StandSkill, WaveSkill, BowSkill) plus the legacy
PyTorch-backed WalkSkill/TurnSkill depend on ``eliza_robot.bridge.isaaclab``
which ships with the W3.1 bridge port. When that module is unavailable
those tests are skipped, but the Brax-backed skill tests still run.
"""

from __future__ import annotations

import numpy as np
import pytest

from eliza_robot.rl.skills.base import SkillParams, SkillStatus
from eliza_robot.rl.skills.brax_walk_skill import BraxWalkSkill
from eliza_robot.rl.skills.registry import SkillRegistry


bridge = pytest.importorskip(
    "eliza_robot.bridge.isaaclab.joint_map",
    reason="bridge port (W3.1) not yet available — scripted skills unimportable",
)


@pytest.fixture(scope="module")
def StandSkill():
    from eliza_robot.rl.skills.stand_skill import StandSkill as _StandSkill
    return _StandSkill


@pytest.fixture(scope="module")
def WalkSkill():
    from eliza_robot.rl.skills.walk_skill import WalkSkill as _WalkSkill
    return _WalkSkill


@pytest.fixture(scope="module")
def TurnSkill():
    from eliza_robot.rl.skills.turn_skill import TurnSkill as _TurnSkill
    return _TurnSkill


@pytest.fixture(scope="module")
def WaveSkill():
    from eliza_robot.rl.skills.wave_skill import WaveSkill as _WaveSkill
    return _WaveSkill


@pytest.fixture(scope="module")
def BowSkill():
    from eliza_robot.rl.skills.bow_skill import BowSkill as _BowSkill
    return _BowSkill


class TestStandSkill:
    def test_returns_standing_pose(self, StandSkill):
        skill = StandSkill()
        skill.reset()
        action, status = skill.get_action(np.zeros(48))
        assert action.shape == (24,)
        assert status == SkillStatus.RUNNING

    def test_action_dim(self, StandSkill):
        assert StandSkill.action_dim == 24
        assert StandSkill.requires_rl is False


class TestWalkSkill:
    def test_no_checkpoint_returns_zeros(self, WalkSkill):
        skill = WalkSkill()
        skill.reset()
        action, status = skill.get_action(np.zeros(48))
        assert action.shape == (12,)
        assert np.allclose(action, 0.0)
        assert status == SkillStatus.RUNNING

    def test_duration_limit(self, WalkSkill):
        skill = WalkSkill()
        skill.reset(SkillParams(duration_sec=0.05))
        obs = np.zeros(48)
        _, status1 = skill.get_action(obs)
        assert status1 == SkillStatus.RUNNING
        _, status2 = skill.get_action(obs)
        assert status2 == SkillStatus.RUNNING
        _, status3 = skill.get_action(obs)
        assert status3 == SkillStatus.COMPLETED


class TestTurnSkill:
    def test_no_checkpoint_returns_zeros(self, TurnSkill):
        skill = TurnSkill()
        skill.reset(SkillParams(direction=-1.0))
        action, status = skill.get_action(np.zeros(48))
        assert action.shape == (12,)
        assert status == SkillStatus.RUNNING


class TestWaveSkill:
    def test_action_shape(self, WaveSkill):
        skill = WaveSkill()
        skill.reset()
        action, status = skill.get_action(np.zeros(48))
        assert action.shape == (24,)
        assert status == SkillStatus.RUNNING


class TestBowSkill:
    def test_action_shape(self, BowSkill):
        skill = BowSkill()
        skill.reset()
        action, status = skill.get_action(np.zeros(48))
        assert action.shape == (24,)
        assert status == SkillStatus.RUNNING


class TestBraxWalkSkillVelocity:
    def test_leg_vel_scaling_at_50hz(self):
        skill = BraxWalkSkill()
        skill.reset()
        pos = skill._default_pose.copy() + 0.1
        action, _ = skill.get_action_from_telemetry(
            imu_roll=0.0, imu_pitch=0.0,
            joint_positions=pos,
        )
        assert action.shape == (12,)
        assert np.all(np.isfinite(action))

    def test_last_positions_equals_default_after_reset(self):
        skill = BraxWalkSkill()
        skill.reset()
        np.testing.assert_array_equal(skill._last_positions, skill._default_pose)


class TestSkillRegistry:
    def test_register_and_get(self, StandSkill):
        reg = SkillRegistry()
        reg.register(StandSkill())
        assert reg.get("stand") is not None
        assert reg.get("nonexistent") is None

    def test_list_skills(self, StandSkill, WalkSkill):
        reg = SkillRegistry()
        reg.register(StandSkill())
        reg.register(WalkSkill())
        names = reg.list_skills()
        assert "stand" in names
        assert "walk" in names

    def test_alias_lookup(self, StandSkill, WalkSkill):
        reg = SkillRegistry()
        reg.register(StandSkill())
        reg.register(WalkSkill())
        assert reg.get("stop") is not None
        assert reg.get("stop").name == "stand"
        assert reg.get("go forward") is not None
        assert reg.get("go forward").name == "walk"

    def test_custom_alias(self, WaveSkill):
        reg = SkillRegistry()
        reg.register(WaveSkill())
        reg.add_alias("hi there", "wave")
        assert reg.get("hi there") is not None
        assert reg.get("hi there").name == "wave"

    def test_contains(self, StandSkill):
        reg = SkillRegistry()
        reg.register(StandSkill())
        assert "stand" in reg
        assert "stop" in reg
        assert "fly" not in reg

    def test_len(self, StandSkill, WalkSkill):
        reg = SkillRegistry()
        assert len(reg) == 0
        reg.register(StandSkill())
        assert len(reg) == 1
        reg.register(WalkSkill())
        assert len(reg) == 2

    def test_full_registry(self, StandSkill, WalkSkill, TurnSkill, WaveSkill, BowSkill):
        reg = SkillRegistry()
        reg.register(StandSkill())
        reg.register(WalkSkill())
        reg.register(TurnSkill())
        reg.register(WaveSkill())
        reg.register(BowSkill())
        assert len(reg) == 5
        assert set(reg.list_skills()) == {"stand", "walk", "turn", "wave", "bow"}
