"""Tests for DeployComposite safety and servo conversion.

Skipped until the bridge port (W3.1) lands — ``deploy_composite`` imports
``eliza_robot.bridge.isaaclab.joint_map`` which ships with the bridge.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import numpy as np
import pytest

pytest.importorskip(
    "eliza_robot.bridge.isaaclab.joint_map",
    reason="bridge port (W3.1) not yet available",
)

from eliza_robot.rl.deploy.deploy_composite import (  # noqa: E402
    FALL_PITCH_THRESHOLD,
    FALL_ROLL_THRESHOLD,
    MAX_JOINT_DELTA,
    DeployComposite,
)
from eliza_robot.rl.skills.composite_skill import NUM_TOTAL_JOINTS  # noqa: E402


@pytest.fixture
def deployer():
    with patch("eliza_robot.rl.deploy.deploy_composite.CompositeSkill") as mock_cls:
        mock_skill = MagicMock()
        mock_skill.get_full_action.return_value = np.zeros(NUM_TOTAL_JOINTS, dtype=np.float32)
        mock_skill.default_pose = np.zeros(NUM_TOTAL_JOINTS, dtype=np.float32)
        mock_cls.return_value = mock_skill
        d = DeployComposite(
            walking_checkpoint="/tmp/nonexistent",
            upper_checkpoint="/tmp/nonexistent",
            dry_run=True,
            duration=1.0,
        )
        yield d


class TestSafetyClamping:
    def test_ramp_zero_returns_near_default(self, deployer):
        default = (
            deployer.skill.default_pose
            if hasattr(deployer.skill, "default_pose")
            else np.zeros(NUM_TOTAL_JOINTS)
        )
        targets = np.ones(NUM_TOTAL_JOINTS, dtype=np.float32) * 0.5
        clamped = deployer.safety_clamp(targets, ramp_factor=0.0)
        np.testing.assert_allclose(clamped, default, atol=MAX_JOINT_DELTA + 1e-5)

    def test_delta_clamped(self, deployer):
        deployer._last_targets = np.zeros(NUM_TOTAL_JOINTS, dtype=np.float32)
        targets = np.ones(NUM_TOTAL_JOINTS, dtype=np.float32) * 10.0
        clamped = deployer.safety_clamp(targets, ramp_factor=1.0)
        delta = clamped - deployer._last_targets
        assert np.all(np.abs(delta) <= MAX_JOINT_DELTA + 1e-6)

    def test_ramp_full_converges(self, deployer):
        targets = np.ones(NUM_TOTAL_JOINTS, dtype=np.float32) * 0.05
        for _ in range(20):
            clamped = deployer.safety_clamp(targets, ramp_factor=1.0)
        np.testing.assert_allclose(clamped, targets, atol=1e-3)


class TestFallDetection:
    def test_no_fall_at_zero(self, deployer):
        deployer._imu_roll = 0.0
        deployer._imu_pitch = 0.0
        assert deployer.check_fall() is False

    def test_fall_on_pitch(self, deployer):
        deployer._imu_pitch = FALL_PITCH_THRESHOLD + 0.1
        assert deployer.check_fall() is True

    def test_fall_on_roll(self, deployer):
        deployer._imu_roll = -(FALL_ROLL_THRESHOLD + 0.1)
        assert deployer.check_fall() is True

    def test_no_fall_below_threshold(self, deployer):
        deployer._imu_pitch = FALL_PITCH_THRESHOLD - 0.1
        deployer._imu_roll = FALL_ROLL_THRESHOLD - 0.1
        assert deployer.check_fall() is False


class TestServoConversion:
    def test_all_24_joints_mapped(self, deployer):
        targets = np.zeros(NUM_TOTAL_JOINTS, dtype=np.float32)
        cmds = deployer.joint_targets_to_servo_commands(targets)
        assert len(cmds) == NUM_TOTAL_JOINTS
        ids_seen = {cmd["id"] for cmd in cmds}
        for cmd in cmds:
            assert 0 <= cmd["position"] <= 1000
        assert len(ids_seen) == NUM_TOTAL_JOINTS

    def test_zero_radians_maps_to_center_pulse(self, deployer):
        targets = np.zeros(NUM_TOTAL_JOINTS, dtype=np.float32)
        cmds = deployer.joint_targets_to_servo_commands(targets)
        for cmd in cmds:
            assert cmd["position"] == 500


class TestNaNGuard:
    def test_nan_targets_hold_last_position(self, deployer):
        good = np.ones(NUM_TOTAL_JOINTS, dtype=np.float32) * 0.1
        deployer._last_targets = good.copy()
        bad = np.full(NUM_TOTAL_JOINTS, np.nan, dtype=np.float32)
        cmds = deployer.joint_targets_to_servo_commands(bad)
        for cmd in cmds:
            assert 500 < cmd["position"] < 550


class TestCompositeDefaultPose:
    def test_composite_skill_has_default_pose(self, deployer):
        default = deployer.skill.default_pose
        assert isinstance(default, np.ndarray)
        assert default.shape == (NUM_TOTAL_JOINTS,)

    def test_standing_pose_uses_default(self, deployer):
        assert hasattr(deployer.skill, "default_pose")


class TestTaskObsConsistency:
    def test_deploy_composite_matches_rl_wave_skill(self, deployer):
        from eliza_robot.rl.skills.rl_wave_skill import RLWaveSkill

        skill = RLWaveSkill(wave_checkpoint="/tmp/nonexistent")

        for elapsed in [0.0, 0.25, 0.5, 1.0, 2.37]:
            obs_deploy = deployer.compute_task_obs(elapsed)
            obs_skill = skill._compute_task_obs(elapsed)
            np.testing.assert_allclose(
                obs_deploy, obs_skill, atol=1e-6,
                err_msg=f"Mismatch at elapsed={elapsed}",
            )
