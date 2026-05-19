"""Parity tests: verify Isaac and Mock backends produce equivalent behavior.

Same client operations should yield same observable outcomes across backends.
"""

from __future__ import annotations

import asyncio
import unittest

from eliza_robot.bridge.backends.rosbridge_isaac import IsaacRosbridgeBackend
from eliza_robot.bridge.backends.rosbridge_mock import MockRosbridgeBackend
from eliza_robot.bridge.types import JsonDict


class BackendParityTests(unittest.TestCase):
    """Run identical operation sequences against two backends and compare."""

    def _run_sequence(self, backend: object) -> dict[str, JsonDict]:
        """Execute a standard operation sequence and capture results."""

        async def _run() -> dict[str, JsonDict]:
            results: dict[str, JsonDict] = {}
            await backend.connect()

            # Set walking params.
            await backend.publish(
                "/app/set_walking_param",
                {"speed": 3, "height": 0.04, "x": 0.02, "y": 0.0, "angle": 5.0},
            )

            # Start walking.
            results["walk_start"] = await backend.call_service(
                "/walking/command", {"command": "start"}
            )

            # Snapshot after start.
            results["snapshot_walking"] = await backend.snapshot_topics()

            # Set head.
            await backend.publish(
                "/head_pan_controller/command", {"position": 0.3, "duration": 0.5}
            )

            # Play action (stops walking).
            await backend.publish("/app/set_action", {"data": "wave"})

            # Snapshot after action.
            results["snapshot_action"] = await backend.snapshot_topics()

            # Stop walking.
            results["walk_stop"] = await backend.call_service(
                "/walking/command", {"command": "stop"}
            )

            # Servo get position.
            results["servo_pos"] = await backend.call_service(
                "/ros_robot_controller/bus_servo/get_position", {"id": [1, 23]}
            )

            # Servo get state.
            results["servo_state"] = await backend.call_service(
                "/ros_robot_controller/bus_servo/get_state",
                {"cmd": [{"id": 1}]},
            )

            await backend.shutdown()
            return results

        return asyncio.run(_run())

    def test_operation_parity(self) -> None:
        isaac_results = self._run_sequence(IsaacRosbridgeBackend())
        mock_results = self._run_sequence(MockRosbridgeBackend())

        # Walk start result parity.
        self.assertEqual(
            isaac_results["walk_start"]["result"],
            mock_results["walk_start"]["result"],
        )

        # Walking state parity after start.
        isaac_walking = isaac_results["snapshot_walking"]["/walking/is_walking"]["data"]
        mock_walking = mock_results["snapshot_walking"]["/walking/is_walking"]["data"]
        self.assertEqual(isaac_walking, mock_walking)

        # Battery presence parity.
        self.assertIn("data", isaac_results["snapshot_walking"]["/ros_robot_controller/battery"])
        self.assertIn("data", mock_results["snapshot_walking"]["/ros_robot_controller/battery"])

        # IMU structure parity.
        isaac_imu = isaac_results["snapshot_walking"]["/imu"]
        mock_imu = mock_results["snapshot_walking"]["/imu"]
        self.assertEqual(set(isaac_imu["orientation"].keys()), set(mock_imu["orientation"].keys()))

        # Action stops walking parity.
        isaac_post_action = isaac_results["snapshot_action"]["/walking/is_walking"]["data"]
        mock_post_action = mock_results["snapshot_action"]["/walking/is_walking"]["data"]
        self.assertEqual(isaac_post_action, mock_post_action)
        self.assertFalse(isaac_post_action)

        # Walk stop parity.
        self.assertEqual(
            isaac_results["walk_stop"]["result"],
            mock_results["walk_stop"]["result"],
        )

        # Servo position response structure parity.
        isaac_servo = isaac_results["servo_pos"]
        mock_servo = mock_results["servo_pos"]
        self.assertEqual(isaac_servo["success"], mock_servo["success"])
        self.assertEqual(len(isaac_servo["position"]), len(mock_servo["position"]))

        # Servo state response structure parity.
        isaac_state = isaac_results["servo_state"]
        mock_state = mock_results["servo_state"]
        self.assertEqual(isaac_state["success"], mock_state["success"])
        self.assertEqual(len(isaac_state["state"]), len(mock_state["state"]))

        # State field keys parity.
        if isaac_state["state"] and mock_state["state"]:
            self.assertEqual(
                set(isaac_state["state"][0].keys()),
                set(mock_state["state"][0].keys()),
            )


if __name__ == "__main__":
    unittest.main()
