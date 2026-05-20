"""Mock backend behavior tests."""

from __future__ import annotations

import asyncio
import unittest

from eliza_robot.bridge.backends.mock_backend import MockBackend
from eliza_robot.bridge.protocol import CommandEnvelope


class MockBackendTests(unittest.TestCase):
    def test_walk_command_flow(self) -> None:
        backend = MockBackend()

        async def _run() -> None:
            await backend.connect()
            response_set = await backend.handle_command(
                CommandEnvelope(
                    request_id="1",
                    timestamp="2026-02-28T00:00:00Z",
                    command="walk.set",
                    payload={"speed": 2, "height": 0.036, "x": 0.01, "y": 0.0, "yaw": 0.0},
                )
            )
            self.assertTrue(response_set.ok)

            response_start = await backend.handle_command(
                CommandEnvelope(
                    request_id="2",
                    timestamp="2026-02-28T00:00:01Z",
                    command="walk.command",
                    payload={"action": "start"},
                )
            )
            self.assertTrue(response_start.ok)
            self.assertTrue(bool(response_start.data["is_walking"]))

            response_stop = await backend.handle_command(
                CommandEnvelope(
                    request_id="3",
                    timestamp="2026-02-28T00:00:02Z",
                    command="walk.command",
                    payload={"action": "stop"},
                )
            )
            self.assertTrue(response_stop.ok)
            self.assertFalse(bool(response_stop.data["is_walking"]))

        asyncio.run(_run())


if __name__ == "__main__":
    unittest.main()

