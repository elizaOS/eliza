"""Tests for policy motion-bound safety checks."""

from __future__ import annotations

import time
import unittest

from eliza_robot.bridge.safety import (
    PolicyHeartbeatMonitor,
    check_policy_motion_bounds,
)


class PolicyMotionBoundsTests(unittest.TestCase):
    """Test policy action clamping and safety gating."""

    def test_within_bounds_passes(self) -> None:
        action = {
            "walk_x": 0.02,
            "walk_y": -0.01,
            "walk_yaw": 5.0,
            "walk_height": 0.036,
            "walk_speed": 2,
        }
        result = check_policy_motion_bounds(action)
        self.assertTrue(result.allowed)
        self.assertEqual(result.reason, "")
        self.assertAlmostEqual(result.clamped["walk_x"], 0.02)

    def test_walk_x_clamped(self) -> None:
        action = {"walk_x": 0.1, "walk_y": 0.0, "walk_yaw": 0.0}
        result = check_policy_motion_bounds(action)
        self.assertTrue(result.allowed)
        self.assertAlmostEqual(result.clamped["walk_x"], 0.05)
        self.assertIn("walk_x clamped", result.reason)

    def test_walk_y_clamped(self) -> None:
        action = {"walk_x": 0.0, "walk_y": -0.2, "walk_yaw": 0.0}
        result = check_policy_motion_bounds(action)
        self.assertTrue(result.allowed)
        self.assertAlmostEqual(result.clamped["walk_y"], -0.05)

    def test_walk_yaw_clamped(self) -> None:
        action = {"walk_x": 0.0, "walk_y": 0.0, "walk_yaw": 25.0}
        result = check_policy_motion_bounds(action)
        self.assertTrue(result.allowed)
        self.assertAlmostEqual(result.clamped["walk_yaw"], 10.0)

    def test_walk_height_clamped(self) -> None:
        action = {"walk_x": 0.0, "walk_y": 0.0, "walk_yaw": 0.0, "walk_height": 0.001}
        result = check_policy_motion_bounds(action)
        self.assertAlmostEqual(result.clamped["walk_height"], 0.015)
        self.assertIn("walk_height clamped", result.reason)

    def test_walk_speed_clamped(self) -> None:
        action = {"walk_x": 0.0, "walk_y": 0.0, "walk_yaw": 0.0, "walk_speed": 10}
        result = check_policy_motion_bounds(action)
        self.assertEqual(result.clamped["walk_speed"], 4)

    def test_head_pan_clamped(self) -> None:
        action = {"walk_x": 0.0, "walk_y": 0.0, "walk_yaw": 0.0, "head_pan": 3.0}
        result = check_policy_motion_bounds(action)
        self.assertAlmostEqual(result.clamped["head_pan"], 1.5)

    def test_head_tilt_clamped(self) -> None:
        action = {"walk_x": 0.0, "walk_y": 0.0, "walk_yaw": 0.0, "head_tilt": -2.0}
        result = check_policy_motion_bounds(action)
        self.assertAlmostEqual(result.clamped["head_tilt"], -1.0)

    def test_defaults_used_for_missing_fields(self) -> None:
        action = {}
        result = check_policy_motion_bounds(action)
        self.assertTrue(result.allowed)
        self.assertAlmostEqual(result.clamped["walk_x"], 0.0)
        self.assertAlmostEqual(result.clamped["walk_y"], 0.0)
        self.assertEqual(result.clamped["walk_speed"], 2)

    def test_multiple_fields_clamped(self) -> None:
        action = {
            "walk_x": 0.1,
            "walk_y": -0.2,
            "walk_yaw": 50.0,
            "walk_height": 0.001,
            "walk_speed": 0,
        }
        result = check_policy_motion_bounds(action)
        self.assertTrue(result.allowed)
        self.assertAlmostEqual(result.clamped["walk_x"], 0.05)
        self.assertAlmostEqual(result.clamped["walk_y"], -0.05)
        self.assertAlmostEqual(result.clamped["walk_yaw"], 10.0)
        self.assertAlmostEqual(result.clamped["walk_height"], 0.015)
        self.assertEqual(result.clamped["walk_speed"], 1)


class PolicyHeartbeatTests(unittest.TestCase):
    """Test policy heartbeat monitoring."""

    def test_not_stale_initially(self) -> None:
        monitor = PolicyHeartbeatMonitor(timeout_sec=1.0)
        self.assertFalse(monitor.is_stale())

    def test_not_stale_after_tick(self) -> None:
        monitor = PolicyHeartbeatMonitor(timeout_sec=1.0)
        monitor.record_tick()
        self.assertFalse(monitor.is_stale())

    def test_stale_after_timeout(self) -> None:
        monitor = PolicyHeartbeatMonitor(timeout_sec=0.01)
        monitor.record_tick()
        time.sleep(0.02)
        self.assertTrue(monitor.is_stale())

    def test_age_sec(self) -> None:
        monitor = PolicyHeartbeatMonitor(timeout_sec=1.0)
        self.assertAlmostEqual(monitor.age_sec(), 0.0)
        monitor.record_tick()
        time.sleep(0.05)
        self.assertGreater(monitor.age_sec(), 0.04)


if __name__ == "__main__":
    unittest.main()
