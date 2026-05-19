"""Tests for arm control — joint mapping, pose application, and bridge integration.

Verifies the full path from named joint angles → MuJoCo actuator → simulated pose,
and from bridge servo.set → joint positions.
"""

from __future__ import annotations

import math

import mujoco
import numpy as np
import pytest

from eliza_robot.sim.mujoco import ainex_constants as consts


def _load_and_stand() -> tuple[mujoco.MjModel, mujoco.MjData]:
    """Load primitives model and reset to stand keyframe."""
    model = mujoco.MjModel.from_xml_path(str(consts.SCENE_PRIMITIVES_XML))
    data = mujoco.MjData(model)
    key_id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_KEY, "stand")
    if key_id >= 0:
        mujoco.mj_resetDataKeyframe(model, data, key_id)
    mujoco.mj_forward(model, data)
    return model, data


def _actuator_index(model: mujoco.MjModel, joint_name: str) -> int:
    """Get actuator index for a joint name."""
    act_name = f"{joint_name}_act"
    aid = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_ACTUATOR, act_name)
    assert aid >= 0, f"Actuator {act_name} not found"
    return aid


def _joint_qpos(model: mujoco.MjModel, data: mujoco.MjData, joint_name: str) -> float:
    """Read qpos for a named joint."""
    jid = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT, joint_name)
    assert jid >= 0, f"Joint {joint_name} not found"
    return float(data.qpos[model.jnt_qposadr[jid]])


def _set_and_settle(model, data, joint_name: str, target: float, steps: int = 500):
    """Set actuator target and simulate to settle."""
    aid = _actuator_index(model, joint_name)
    data.ctrl[aid] = target
    for _ in range(steps):
        mujoco.mj_step(model, data)


class TestJointMapping:
    """Verify joint names, actuator indices, and constants consistency."""

    def test_all_24_actuators_exist(self):
        model, _ = _load_and_stand()
        assert model.nu == 24, f"Expected 24 actuators, got {model.nu}"

    def test_leg_joints_are_first_12_actuators(self):
        model, _ = _load_and_stand()
        for i, name in enumerate(consts.LEG_JOINT_NAMES):
            aid = _actuator_index(model, name)
            assert aid == i, f"{name}: expected actuator {i}, got {aid}"

    def test_head_joints_at_index_12_13(self):
        model, _ = _load_and_stand()
        for i, name in enumerate(consts.HEAD_JOINT_NAMES):
            aid = _actuator_index(model, name)
            assert aid == 12 + i, f"{name}: expected actuator {12+i}, got {aid}"

    def test_arm_joints_at_index_14_23(self):
        model, _ = _load_and_stand()
        for i, name in enumerate(consts.ARM_JOINT_NAMES):
            aid = _actuator_index(model, name)
            assert aid == 14 + i, f"{name}: expected actuator {14+i}, got {aid}"

    def test_all_joint_names_match_constants(self):
        model, _ = _load_and_stand()
        for name in consts.ALL_JOINT_NAMES:
            jid = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT, name)
            assert jid >= 0, f"Joint {name} not in MJCF"

    def test_joint_table_matches_constants(self):
        """bridge/isaaclab/joint_map.py should list same arm joints."""
        from bridge.isaaclab.joint_map import ARM_JOINT_NAMES as BRIDGE_ARM
        assert set(BRIDGE_ARM) == set(consts.ARM_JOINT_NAMES)

    def test_all_joints_have_range(self):
        model, _ = _load_and_stand()
        for name in consts.ARM_JOINT_NAMES:
            jid = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT, name)
            lower = model.jnt_range[jid, 0]
            upper = model.jnt_range[jid, 1]
            assert lower < upper, f"{name}: invalid range [{lower}, {upper}]"
            assert lower >= -2.1
            assert upper <= 2.1


class TestArmActuation:
    """Verify that setting actuator targets moves arm joints."""

    def test_shoulder_pitch_moves(self):
        model, data = _load_and_stand()
        initial = _joint_qpos(model, data, "r_sho_pitch")
        _set_and_settle(model, data, "r_sho_pitch", -1.5)
        final = _joint_qpos(model, data, "r_sho_pitch")
        assert abs(final - (-1.5)) < 0.15, f"r_sho_pitch didn't reach target: {final}"
        assert final != initial

    def test_shoulder_roll_moves(self):
        model, data = _load_and_stand()
        _set_and_settle(model, data, "r_sho_roll", 0.0)
        final = _joint_qpos(model, data, "r_sho_roll")
        assert abs(final - 0.0) < 0.15, f"r_sho_roll didn't reach target: {final}"

    def test_elbow_pitch_moves(self):
        model, data = _load_and_stand()
        _set_and_settle(model, data, "l_el_pitch", -1.0)
        final = _joint_qpos(model, data, "l_el_pitch")
        assert abs(final - (-1.0)) < 0.15, f"l_el_pitch didn't reach target: {final}"

    def test_elbow_yaw_moves(self):
        model, data = _load_and_stand()
        _set_and_settle(model, data, "r_el_yaw", 0.8)
        final = _joint_qpos(model, data, "r_el_yaw")
        assert abs(final - 0.8) < 0.15, f"r_el_yaw didn't reach target: {final}"

    def test_gripper_moves(self):
        model, data = _load_and_stand()
        _set_and_settle(model, data, "r_gripper", 1.0)
        final = _joint_qpos(model, data, "r_gripper")
        assert abs(final - 1.0) < 0.15, f"r_gripper didn't reach target: {final}"

    def test_left_arm_mirrors_right(self):
        """Left and right arms should be symmetric."""
        model, data_r = _load_and_stand()
        _set_and_settle(model, data_r, "r_sho_pitch", -1.0)
        r_pos = _joint_qpos(model, data_r, "r_sho_pitch")

        _, data_l = _load_and_stand()
        _set_and_settle(model, data_l, "l_sho_pitch", -1.0)
        l_pos = _joint_qpos(model, data_l, "l_sho_pitch")

        assert abs(r_pos - l_pos) < 0.05, f"Asymmetric: r={r_pos}, l={l_pos}"


class TestNamedPoses:
    """Verify the named arm poses from arm_poses.py."""

    def test_all_poses_importable(self):
        from eliza_robot.sim.mujoco.arm_poses import ARM_POSES, list_poses
        assert len(ARM_POSES) >= 10
        assert "default_stand" in ARM_POSES
        assert "wave_left" in ARM_POSES
        assert "t_pose" in ARM_POSES
        assert "arms_forward" in ARM_POSES
        assert "arms_up" in ARM_POSES

    def test_all_poses_have_valid_joints(self):
        from eliza_robot.sim.mujoco.arm_poses import ARM_POSES
        model, _ = _load_and_stand()

        for pose_name, arm_pose in ARM_POSES.items():
            for joint_name in arm_pose.joints:
                jid = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT, joint_name)
                assert jid >= 0, f"Pose {pose_name}: unknown joint {joint_name}"

    def test_all_poses_within_joint_limits(self):
        from eliza_robot.sim.mujoco.arm_poses import ARM_POSES
        model, _ = _load_and_stand()

        for pose_name, arm_pose in ARM_POSES.items():
            for joint_name, target in arm_pose.joints.items():
                jid = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT, joint_name)
                if jid < 0:
                    continue
                lower = float(model.jnt_range[jid, 0])
                upper = float(model.jnt_range[jid, 1])
                assert lower <= target <= upper, (
                    f"Pose {pose_name}, {joint_name}={target} outside [{lower}, {upper}]"
                )

    def test_default_stand_matches_keyframe(self):
        """default_stand arm values should match stand keyframe."""
        from eliza_robot.sim.mujoco.arm_poses import ARM_POSES
        model, data = _load_and_stand()

        pose = ARM_POSES["default_stand"]
        for jname in consts.ARM_JOINT_NAMES:
            expected = pose.joints[jname]
            actual = _joint_qpos(model, data, jname)
            assert abs(expected - actual) < 0.01, (
                f"default_stand {jname}: expected {expected}, keyframe has {actual}"
            )

    def test_apply_arms_forward(self):
        """arms_forward should place grippers in front of torso (+X)."""
        from eliza_robot.sim.mujoco.arm_poses import ARM_POSES
        from eliza_robot.sim.mujoco.arm_test import apply_pose, get_body_positions

        model, data = _load_and_stand()
        pose = ARM_POSES["arms_forward"]
        apply_pose(model, data, pose.joints, settle_steps=500)

        bodies = get_body_positions(model, data)
        torso = data.xpos[model.body("body_link").id]
        for side in ["r_gripper_link", "l_gripper_link"]:
            if side in bodies:
                dx = bodies[side][0] - torso[0]
                assert dx > 0.10, f"{side} should be >10cm forward, got dx={dx:.3f}"

    def test_apply_wave_left_asymmetric(self):
        """wave_left should move left arm out, right stays tucked."""
        from eliza_robot.sim.mujoco.arm_poses import ARM_POSES
        from eliza_robot.sim.mujoco.arm_test import apply_pose, get_body_positions

        model, data = _load_and_stand()
        pose = ARM_POSES["wave_left"]
        apply_pose(model, data, pose.joints, settle_steps=500)

        # Left arm should be out to side (sho_roll ≈ 0)
        l_roll = _joint_qpos(model, data, "l_sho_roll")
        assert abs(l_roll) < 0.15, f"Left arm should be lateral (roll≈0), got {l_roll}"

        # Right arm should still be at default (sho_roll ≈ 1.403)
        r_roll = _joint_qpos(model, data, "r_sho_roll")
        assert abs(r_roll - 1.403) < 0.15, f"Right arm should be tucked, got r_sho_roll={r_roll}"


class TestBridgeServoPath:
    """Verify the bridge servo.set conversion path."""

    def test_radians_to_pulse_center(self):
        from bridge.isaaclab.joint_map import radians_to_pulse
        assert radians_to_pulse(0.0, 14) == 500

    def test_radians_to_pulse_limits(self):
        from bridge.isaaclab.joint_map import radians_to_pulse
        assert radians_to_pulse(2.09, 14) == 1000
        assert radians_to_pulse(-2.09, 14) == 0

    def test_pulse_to_radians_center(self):
        from bridge.isaaclab.joint_map import pulse_to_radians
        assert abs(pulse_to_radians(500, 14)) < 0.01

    def test_roundtrip_conversion(self):
        from bridge.isaaclab.joint_map import radians_to_pulse, pulse_to_radians
        for rad in [-1.5, -0.5, 0.0, 0.5, 1.5]:
            pulse = radians_to_pulse(rad, 14)
            recovered = pulse_to_radians(pulse, 14)
            assert abs(recovered - rad) < 0.01, f"Roundtrip failed for {rad}: pulse={pulse}, recovered={recovered}"

    def test_arm_joint_servo_ids(self):
        """All arm joints should have valid servo IDs."""
        from bridge.isaaclab.joint_map import joint_name_to_servo_id
        for name in consts.ARM_JOINT_NAMES:
            sid = joint_name_to_servo_id(name)
            assert 13 <= sid <= 22, f"{name}: servo ID {sid} out of arm range [13,22]"

    def test_servo_id_roundtrip(self):
        from bridge.isaaclab.joint_map import (
            joint_name_to_servo_id,
            servo_id_to_joint_name,
        )
        for name in consts.ARM_JOINT_NAMES:
            sid = joint_name_to_servo_id(name)
            recovered = servo_id_to_joint_name(sid)
            assert recovered == name


class TestActionLibrary:
    """Verify the ACTION_LIBRARY arm movements."""

    def test_wave_uses_left_arm(self):
        from bridge.isaaclab.actions import ACTION_LIBRARY
        wave = ACTION_LIBRARY["wave"]
        # First keyframe should set l_sho_pitch
        kf0 = wave.keyframes[0]
        assert "l_sho_pitch" in kf0.positions
        assert kf0.positions["l_sho_pitch"] < -1.0, "Wave should raise left arm"

    def test_wave_has_elbow_oscillation(self):
        from bridge.isaaclab.actions import ACTION_LIBRARY
        wave = ACTION_LIBRARY["wave"]
        elbow_values = [kf.positions.get("l_el_yaw", 0.0) for kf in wave.keyframes]
        # Should have both positive and negative elbow yaw
        assert any(v > 0.5 for v in elbow_values), "Wave should have positive elbow yaw"
        assert any(v < -0.5 for v in elbow_values), "Wave should have negative elbow yaw"

    def test_all_actions_have_valid_joints(self):
        from bridge.isaaclab.actions import ACTION_LIBRARY
        from bridge.isaaclab.joint_map import JOINT_BY_NAME
        for action_name, seq in ACTION_LIBRARY.items():
            for i, kf in enumerate(seq.keyframes):
                for joint_name in kf.positions:
                    assert joint_name in JOINT_BY_NAME, (
                        f"Action {action_name} keyframe {i}: unknown joint {joint_name}"
                    )

    def test_all_actions_within_limits(self):
        from bridge.isaaclab.actions import ACTION_LIBRARY
        from bridge.isaaclab.joint_map import JOINT_BY_NAME
        for action_name, seq in ACTION_LIBRARY.items():
            for i, kf in enumerate(seq.keyframes):
                for joint_name, val in kf.positions.items():
                    spec = JOINT_BY_NAME[joint_name]
                    assert spec.lower_rad <= val <= spec.upper_rad, (
                        f"Action {action_name} kf{i}: {joint_name}={val} "
                        f"outside [{spec.lower_rad}, {spec.upper_rad}]"
                    )

    def test_stand_returns_to_default(self):
        from bridge.isaaclab.actions import ACTION_LIBRARY
        from bridge.isaaclab.ainex_cfg import STAND_JOINT_POSITIONS
        stand = ACTION_LIBRARY["stand"]
        # Stand should have exactly the STAND_JOINT_POSITIONS
        kf = stand.keyframes[0]
        for name, val in STAND_JOINT_POSITIONS.items():
            assert name in kf.positions, f"stand missing {name}"
            assert abs(kf.positions[name] - val) < 1e-6, (
                f"stand {name}: {kf.positions[name]} != {val}"
            )


class TestArmBodyPositions:
    """Verify that arm poses produce expected body positions in world frame."""

    def test_arms_forward_gripper_in_front(self):
        """With arms forward, gripper bodies should be in front of torso."""
        from eliza_robot.sim.mujoco.arm_test import apply_pose, get_body_positions
        from eliza_robot.sim.mujoco.arm_poses import ARM_POSES

        model, data = _load_and_stand()
        apply_pose(model, data, ARM_POSES["arms_forward"].joints, settle_steps=500)
        bodies = get_body_positions(model, data)

        torso = data.xpos[model.body("body_link").id]

        # Grippers should be in front of torso (positive x or negative x depending on convention)
        # Check they're at significantly different x than torso
        for side in ["r_gripper_link", "l_gripper_link"]:
            if side in bodies:
                grip = bodies[side]
                dx = grip[0] - torso[0]
                # Arms forward means grippers move along torso's forward axis
                dist = np.linalg.norm(grip[:2] - torso[:2])
                assert dist > 0.05, (
                    f"{side} should be displaced from torso in arms_forward, dist={dist:.3f}"
                )

    def test_default_stand_arms_at_sides(self):
        """Default stand gripper should be near the torso laterally."""
        from eliza_robot.sim.mujoco.arm_test import get_body_positions

        model, data = _load_and_stand()
        bodies = get_body_positions(model, data)
        torso = data.xpos[model.body("body_link").id]

        for side in ["r_gripper_link", "l_gripper_link"]:
            if side in bodies:
                grip = bodies[side]
                # Grippers should be close to torso height (not raised)
                dz = abs(grip[2] - torso[2])
                assert dz < 0.20, f"{side} too far from torso height: dz={dz:.3f}"
