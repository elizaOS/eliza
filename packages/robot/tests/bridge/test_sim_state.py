"""Tests for simulation state management."""

from __future__ import annotations

import unittest

from eliza_robot.bridge.isaaclab.sim_state import SimRobotState


class SimRobotStateTests(unittest.TestCase):
    def test_initial_state(self) -> None:
        state = SimRobotState()
        self.assertFalse(state.walk.is_walking)
        self.assertTrue(state.walk.enabled)
        self.assertEqual(state.battery_mv, 12400)
        self.assertEqual(state.last_action, "stand")

    def test_walk_lifecycle(self) -> None:
        state = SimRobotState()
        state.apply_walk_params(speed=3, height=0.04, x=0.02, y=0.0, angle=5.0)
        self.assertEqual(state.walk.speed, 3)
        self.assertAlmostEqual(state.walk.x, 0.02)

        self.assertTrue(state.apply_walk_command("start"))
        self.assertTrue(state.walk.is_walking)

        self.assertTrue(state.apply_walk_command("stop"))
        self.assertFalse(state.walk.is_walking)

    def test_walk_disable(self) -> None:
        state = SimRobotState()
        state.apply_walk_command("start")
        self.assertTrue(state.walk.is_walking)

        state.apply_walk_command("disable")
        self.assertFalse(state.walk.is_walking)
        self.assertFalse(state.walk.enabled)

        # Can't start when disabled.
        state.apply_walk_command("start")
        self.assertFalse(state.walk.is_walking)

    def test_head_control(self) -> None:
        state = SimRobotState()
        state.apply_head(pan=0.5, tilt=-0.3)
        self.assertAlmostEqual(state.head.pan, 0.5)
        self.assertAlmostEqual(state.head.tilt, -0.3)

    def test_action_stops_walking(self) -> None:
        state = SimRobotState()
        state.apply_walk_command("start")
        self.assertTrue(state.walk.is_walking)

        state.apply_action("wave")
        self.assertFalse(state.walk.is_walking)
        self.assertEqual(state.last_action, "wave")

    def test_tick_drains_battery(self) -> None:
        state = SimRobotState()
        state.apply_walk_command("start")
        initial_battery = state.battery_mv
        for _ in range(100):
            state.tick()
        self.assertLess(state.battery_mv, initial_battery)

    def test_tick_updates_imu_when_walking(self) -> None:
        state = SimRobotState()
        state.apply_walk_params(speed=2, height=0.036, x=0.01, y=0.0, angle=10.0)
        state.apply_walk_command("start")
        state.tick(dt=0.5)
        imu = state.imu_orientation
        # With non-zero angle, z component should be non-zero.
        self.assertNotAlmostEqual(imu["z"], 0.0)

    def test_servo_position_default(self) -> None:
        state = SimRobotState()
        pulse = state.get_servo_position(23)
        self.assertEqual(pulse, 500)

    def test_snapshot_telemetry(self) -> None:
        state = SimRobotState()
        state.ready = True
        snapshot = state.snapshot_telemetry()
        self.assertIn("/walking/is_walking", snapshot)
        self.assertIn("/ros_robot_controller/battery", snapshot)
        self.assertIn("/imu", snapshot)
        self.assertIn("/bridge/state", snapshot)

    def test_battery_floor(self) -> None:
        state = SimRobotState()
        state.battery_mv = 10400
        state.apply_walk_command("start")
        for _ in range(1000):
            state.tick()
        self.assertGreaterEqual(state.battery_mv, 10400)


if __name__ == "__main__":
    unittest.main()
