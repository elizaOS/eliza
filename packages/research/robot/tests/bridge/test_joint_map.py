"""Tests for joint mapping module."""

from __future__ import annotations

import unittest

from eliza_robot.bridge.isaaclab.joint_map import (
    ARM_JOINT_NAMES,
    HEAD_JOINT_NAMES,
    JOINT_BY_NAME,
    JOINT_BY_SERVO_ID,
    JOINT_NAMES,
    JOINT_TABLE,
    LEG_JOINT_NAMES,
    NUM_JOINTS,
    joint_name_to_servo_id,
    pulse_to_radians,
    radians_to_pulse,
    servo_id_to_joint_name,
)


class JointMapTests(unittest.TestCase):
    def test_joint_count(self) -> None:
        self.assertEqual(NUM_JOINTS, 24)
        self.assertEqual(len(JOINT_TABLE), 24)
        self.assertEqual(len(JOINT_NAMES), 24)

    def test_group_counts(self) -> None:
        self.assertEqual(len(LEG_JOINT_NAMES), 12)
        self.assertEqual(len(ARM_JOINT_NAMES), 10)
        self.assertEqual(len(HEAD_JOINT_NAMES), 2)

    def test_servo_id_unique(self) -> None:
        ids = [j.servo_id for j in JOINT_TABLE]
        self.assertEqual(len(ids), len(set(ids)))

    def test_name_unique(self) -> None:
        names = [j.urdf_name for j in JOINT_TABLE]
        self.assertEqual(len(names), len(set(names)))

    def test_bidirectional_lookup(self) -> None:
        for spec in JOINT_TABLE:
            self.assertEqual(servo_id_to_joint_name(spec.servo_id), spec.urdf_name)
            self.assertEqual(joint_name_to_servo_id(spec.urdf_name), spec.servo_id)

    def test_lookup_errors(self) -> None:
        with self.assertRaises(ValueError):
            servo_id_to_joint_name(999)
        with self.assertRaises(ValueError):
            joint_name_to_servo_id("nonexistent")

    def test_pulse_radians_roundtrip(self) -> None:
        for servo_id in [1, 12, 23]:
            pulse = 500
            rad = pulse_to_radians(pulse, servo_id)
            self.assertAlmostEqual(rad, 0.0, places=5)

            back = radians_to_pulse(rad, servo_id)
            self.assertEqual(back, 500)

    def test_pulse_radians_limits(self) -> None:
        rad = pulse_to_radians(0, 1)
        self.assertAlmostEqual(rad, -2.09, places=1)
        rad = pulse_to_radians(1000, 1)
        self.assertAlmostEqual(rad, 2.09, places=1)

    def test_radians_pulse_clamped(self) -> None:
        pulse = radians_to_pulse(10.0, 1)
        self.assertEqual(pulse, 1000)
        pulse = radians_to_pulse(-10.0, 1)
        self.assertEqual(pulse, 0)

    def test_by_name_lookup(self) -> None:
        spec = JOINT_BY_NAME.get("head_pan")
        self.assertIsNotNone(spec)
        if spec is not None:
            self.assertEqual(spec.servo_id, 23)

    def test_by_servo_id_lookup(self) -> None:
        spec = JOINT_BY_SERVO_ID.get(24)
        self.assertIsNotNone(spec)
        if spec is not None:
            self.assertEqual(spec.urdf_name, "head_tilt")

    def test_real_robot_servo_ids(self) -> None:
        """Verify servo IDs match ainex_controller.py Controller.joint_id."""
        expected = {
            "r_hip_yaw": 12, "r_hip_roll": 10, "r_hip_pitch": 8,
            "r_knee": 6, "r_ank_pitch": 4, "r_ank_roll": 2,
            "l_hip_yaw": 11, "l_hip_roll": 9, "l_hip_pitch": 7,
            "l_knee": 5, "l_ank_pitch": 3, "l_ank_roll": 1,
            "r_sho_pitch": 14, "r_sho_roll": 16, "r_el_pitch": 18,
            "r_el_yaw": 20, "r_gripper": 22,
            "l_sho_pitch": 13, "l_sho_roll": 15, "l_el_pitch": 17,
            "l_el_yaw": 19, "l_gripper": 21,
            "head_pan": 23, "head_tilt": 24,
        }
        for name, expected_id in expected.items():
            self.assertEqual(
                joint_name_to_servo_id(name), expected_id,
                f"{name}: expected servo ID {expected_id}",
            )


if __name__ == "__main__":
    unittest.main()
