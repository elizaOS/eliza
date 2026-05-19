"""Tests for IsaacLab backend (command-envelope protocol)."""

from __future__ import annotations

import asyncio
import unittest

from eliza_robot.bridge.backends.isaac_backend import IsaacBackend
from eliza_robot.bridge.protocol import CommandEnvelope, utc_now_iso


def _cmd(command: str, payload: dict[str, object]) -> CommandEnvelope:
    return CommandEnvelope(
        request_id="test-1",
        timestamp=utc_now_iso(),
        command=command,
        payload=payload,
    )


class IsaacBackendTests(unittest.TestCase):
    def test_walk_set_and_command(self) -> None:
        backend = IsaacBackend()

        async def _run() -> None:
            await backend.connect()
            self.assertEqual(backend.backend_name, "isaac")

            resp = await backend.handle_command(
                _cmd("walk.set", {"speed": 3, "height": 0.04, "x": 0.02, "y": 0.0, "yaw": 5.0})
            )
            self.assertTrue(resp.ok)

            resp = await backend.handle_command(_cmd("walk.command", {"action": "start"}))
            self.assertTrue(resp.ok)
            self.assertTrue(resp.data.get("is_walking"))

            resp = await backend.handle_command(_cmd("walk.command", {"action": "stop"}))
            self.assertTrue(resp.ok)

            events = await backend.poll_events()
            self.assertGreaterEqual(len(events), 1)
            self.assertEqual(events[0].event, "telemetry.basic")

            await backend.shutdown()

        asyncio.run(_run())

    def test_action_play(self) -> None:
        backend = IsaacBackend()

        async def _run() -> None:
            await backend.connect()
            resp = await backend.handle_command(_cmd("action.play", {"name": "wave"}))
            self.assertTrue(resp.ok)
            await backend.shutdown()

        asyncio.run(_run())

    def test_head_set(self) -> None:
        backend = IsaacBackend()

        async def _run() -> None:
            await backend.connect()
            resp = await backend.handle_command(
                _cmd("head.set", {"pan": 0.5, "tilt": -0.3, "duration": 0.5})
            )
            self.assertTrue(resp.ok)
            await backend.shutdown()

        asyncio.run(_run())

    def test_unsupported_command(self) -> None:
        backend = IsaacBackend()

        async def _run() -> None:
            await backend.connect()
            resp = await backend.handle_command(_cmd("unknown.cmd", {}))
            self.assertFalse(resp.ok)
            await backend.shutdown()

        asyncio.run(_run())

    def test_not_connected(self) -> None:
        backend = IsaacBackend()

        async def _run() -> None:
            resp = await backend.handle_command(
                _cmd("walk.set", {"speed": 2, "height": 0.036, "x": 0.0, "y": 0.0, "yaw": 0.0})
            )
            self.assertFalse(resp.ok)

        asyncio.run(_run())

    def test_capabilities(self) -> None:
        backend = IsaacBackend()
        caps = backend.capabilities()
        self.assertTrue(caps.get("walk_set"))
        self.assertTrue(caps.get("walk_command"))
        self.assertTrue(caps.get("action_play"))
        self.assertTrue(caps.get("head_set"))


if __name__ == "__main__":
    unittest.main()
