"""Shared fixtures for webhook plugin tests."""

from __future__ import annotations

import asyncio
from typing import Any, Optional
from unittest.mock import AsyncMock

import pytest

from elizaos_plugin_webhooks.handlers import AgentRuntime


class MockRuntime:
    """Minimal mock that satisfies the :class:`AgentRuntime` protocol."""

    def __init__(
        self,
        *,
        agent_id: str = "agent-001",
        settings: Optional[dict[str, Any]] = None,
    ) -> None:
        self.agent_id = agent_id
        self._settings: dict[str, Any] = settings or {}

        # Track calls for assertions
        self.emit_event = AsyncMock()
        self.get_rooms = AsyncMock(return_value=[])
        self.get_room = AsyncMock(return_value=None)
        self.create_room = AsyncMock()
        self.add_participant = AsyncMock()
        self.send_message_to_target = AsyncMock()
        self.handle_message = AsyncMock()

    def get_character_settings(self) -> dict[str, Any]:
        return self._settings


@pytest.fixture()
def make_runtime():
    """Factory fixture that returns a ``MockRuntime`` builder."""

    def _factory(
        *,
        token: str = "test-secret",
        enabled: bool = True,
        mappings: Optional[list[dict[str, Any]]] = None,
        presets: Optional[list[str]] = None,
    ) -> MockRuntime:
        hooks: dict[str, Any] = {
            "enabled": enabled,
            "token": token,
        }
        if mappings is not None:
            hooks["mappings"] = mappings
        if presets is not None:
            hooks["presets"] = presets
        return MockRuntime(settings={"hooks": hooks})

    return _factory
