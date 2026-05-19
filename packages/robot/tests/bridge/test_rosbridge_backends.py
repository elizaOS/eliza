"""ROSBridge-compatible backend behavior tests."""

from __future__ import annotations

import asyncio
import unittest

from eliza_robot.bridge.backends.rosbridge_isaac import IsaacRosbridgeBackend


class IsaacRosbridgeBackendTests(unittest.TestCase):
    def test_publish_and_service_flow(self) -> None:
        backend = IsaacRosbridgeBackend()

        async def _run() -> None:
            await backend.connect()

            await backend.publish(
                "/app/set_walking_param",
                {"speed": 2, "height": 0.036, "x": 0.01, "y": 0.0, "angle": 0.0},
            )
            start_result = await backend.call_service("/walking/command", {"command": "start"})
            self.assertTrue(bool(start_result["result"]))

            snapshot = await backend.snapshot_topics()
            self.assertTrue(bool(snapshot["/walking/is_walking"]["data"]))

            await backend.publish("/head_pan_controller/command", {"position": 0.2, "duration": 0.3})
            await backend.publish("/head_tilt_controller/command", {"position": -0.1, "duration": 0.3})
            await backend.publish("/app/set_action", {"data": "wave"})

            stop_result = await backend.call_service("/walking/command", {"command": "stop"})
            self.assertTrue(bool(stop_result["result"]))

            servo_result = await backend.call_service(
                "/ros_robot_controller/bus_servo/get_position",
                {"id": [23, 24]},
            )
            self.assertTrue(bool(servo_result["success"]))
            self.assertEqual(len(list(servo_result["position"])), 2)

            state_result = await backend.call_service(
                "/ros_robot_controller/bus_servo/get_state",
                {"cmd": [{"id": 23, "get_position": 1, "get_voltage": 1}]},
            )
            self.assertTrue(bool(state_result["success"]))
            self.assertEqual(len(list(state_result["state"])), 1)

            await backend.shutdown()

        asyncio.run(_run())


if __name__ == "__main__":
    unittest.main()
