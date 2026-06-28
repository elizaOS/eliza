"""Mock backend for ROSBridge-compatible server tests."""

from __future__ import annotations

from eliza_robot.bridge.backends.rosbridge_isaac import IsaacRosbridgeBackend


class MockRosbridgeBackend(IsaacRosbridgeBackend):
    """Mock backend reusing deterministic in-memory simulator behavior."""

    @property
    def backend_name(self) -> str:
        return "mock"
