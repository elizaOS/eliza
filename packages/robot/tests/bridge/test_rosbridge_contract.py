"""Contract tests for ROSBridge-compatible websocket operations.

Validates that all backends conform to the same ROSBridge wire protocol contract:
- publish/subscribe lifecycle
- service call semantics
- topic snapshot format
- error handling
"""

from __future__ import annotations

import asyncio
import unittest

from eliza_robot.bridge.backends.rosbridge_isaac import IsaacRosbridgeBackend
from eliza_robot.bridge.backends.rosbridge_mock import MockRosbridgeBackend
from eliza_robot.bridge.types import JsonDict


class _BackendContractMixin:
    """Shared contract tests run against every ROSBridge backend."""

    backend: object

    def _run(self, coro: object) -> object:
        return asyncio.run(coro)

    def test_connect_and_shutdown(self) -> None:
        async def _run() -> None:
            await self.backend.connect()
            await self.backend.shutdown()

        self._run(_run())

    def test_capabilities_structure(self) -> None:
        caps = self.backend.capabilities()
        self.assertIsInstance(caps, dict)
        self.assertIn("protocol", caps)
        self.assertEqual(caps["protocol"], "rosbridge_compatible")

    def test_publish_walking_param(self) -> None:
        async def _run() -> None:
            await self.backend.connect()
            await self.backend.publish(
                "/app/set_walking_param",
                {"speed": 2, "height": 0.036, "x": 0.01, "y": 0.0, "angle": 0.0},
            )
            await self.backend.shutdown()

        self._run(_run())

    def test_publish_action(self) -> None:
        async def _run() -> None:
            await self.backend.connect()
            await self.backend.publish("/app/set_action", {"data": "wave"})
            await self.backend.shutdown()

        self._run(_run())

    def test_publish_head(self) -> None:
        async def _run() -> None:
            await self.backend.connect()
            await self.backend.publish(
                "/head_pan_controller/command", {"position": 0.2, "duration": 0.3}
            )
            await self.backend.publish(
                "/head_tilt_controller/command", {"position": -0.1, "duration": 0.3}
            )
            await self.backend.shutdown()

        self._run(_run())

    def test_publish_servo_position(self) -> None:
        async def _run() -> None:
            await self.backend.connect()
            await self.backend.publish(
                "/ros_robot_controller/bus_servo/set_position",
                {"duration": 0.3, "position": [{"id": 23, "position": 500}]},
            )
            await self.backend.shutdown()

        self._run(_run())

    def test_publish_unsupported_topic(self) -> None:
        async def _run() -> None:
            await self.backend.connect()
            with self.assertRaises(ValueError):
                await self.backend.publish("/nonexistent/topic", {})
            await self.backend.shutdown()

        self._run(_run())

    def test_service_walking_command(self) -> None:
        async def _run() -> None:
            await self.backend.connect()
            result = await self.backend.call_service(
                "/walking/command", {"command": "start"}
            )
            self.assertIsInstance(result, dict)
            self.assertIn("result", result)
            self.assertTrue(result["result"])

            result = await self.backend.call_service(
                "/walking/command", {"command": "stop"}
            )
            self.assertTrue(result["result"])
            await self.backend.shutdown()

        self._run(_run())

    def test_service_servo_get_position(self) -> None:
        async def _run() -> None:
            await self.backend.connect()
            result = await self.backend.call_service(
                "/ros_robot_controller/bus_servo/get_position", {"id": [23, 24]}
            )
            self.assertIsInstance(result, dict)
            self.assertTrue(result["success"])
            positions = result["position"]
            self.assertIsInstance(positions, list)
            self.assertEqual(len(positions), 2)
            for p in positions:
                self.assertIn("id", p)
                self.assertIn("position", p)
            await self.backend.shutdown()

        self._run(_run())

    def test_service_servo_get_state(self) -> None:
        async def _run() -> None:
            await self.backend.connect()
            result = await self.backend.call_service(
                "/ros_robot_controller/bus_servo/get_state",
                {"cmd": [{"id": 23, "get_position": 1}]},
            )
            self.assertIsInstance(result, dict)
            self.assertTrue(result["success"])
            states = result["state"]
            self.assertIsInstance(states, list)
            self.assertEqual(len(states), 1)
            await self.backend.shutdown()

        self._run(_run())

    def test_service_unsupported(self) -> None:
        async def _run() -> None:
            await self.backend.connect()
            with self.assertRaises(ValueError):
                await self.backend.call_service("/nonexistent/service", {})
            await self.backend.shutdown()

        self._run(_run())

    def test_snapshot_topics_structure(self) -> None:
        async def _run() -> None:
            await self.backend.connect()
            snapshot = await self.backend.snapshot_topics()
            self.assertIsInstance(snapshot, dict)
            self.assertIn("/walking/is_walking", snapshot)
            self.assertIn("/ros_robot_controller/battery", snapshot)
            self.assertIn("/imu", snapshot)

            # Validate topic message shapes.
            walking = snapshot["/walking/is_walking"]
            self.assertIn("data", walking)
            self.assertIsInstance(walking["data"], bool)

            battery = snapshot["/ros_robot_controller/battery"]
            self.assertIn("data", battery)
            self.assertIsInstance(battery["data"], int)

            imu = snapshot["/imu"]
            self.assertIn("orientation", imu)
            orientation = imu["orientation"]
            self.assertIsInstance(orientation, dict)
            for key in ("x", "y", "z", "w"):
                self.assertIn(key, orientation)

            await self.backend.shutdown()

        self._run(_run())

    def test_not_connected_errors(self) -> None:
        async def _run() -> None:
            with self.assertRaises(RuntimeError):
                await self.backend.publish("/app/set_walking_param", {"speed": 2})
            with self.assertRaises(RuntimeError):
                await self.backend.call_service("/walking/command", {"command": "start"})

        self._run(_run())


class IsaacContractTests(_BackendContractMixin, unittest.TestCase):
    def setUp(self) -> None:
        self.backend = IsaacRosbridgeBackend()


class MockContractTests(_BackendContractMixin, unittest.TestCase):
    def setUp(self) -> None:
        self.backend = MockRosbridgeBackend()


if __name__ == "__main__":
    unittest.main()
