"""
Shared fixtures for Twitch plugin tests.

We mock the ``twitchio`` third-party dependency before importing the plugin
package so that tests can run without it installed.
"""

import sys
import types as stdlib_types
from dataclasses import dataclass, field
from typing import Optional
from unittest.mock import AsyncMock, MagicMock

import pytest

# ---------------------------------------------------------------------------
# Mock twitchio so that elizaos_plugin_twitch can be imported without it
# ---------------------------------------------------------------------------

_twitchio_mock = MagicMock()
_twitchio_ext_mock = MagicMock()
_twitchio_ext_commands_mock = MagicMock()
# commands.Bot needs to be a class-like object so TwitchBot can subclass it
_twitchio_ext_commands_mock.Bot = type("Bot", (), {"__init__": lambda *a, **kw: None})

sys.modules.setdefault("twitchio", _twitchio_mock)
sys.modules.setdefault("twitchio.ext", _twitchio_ext_mock)
sys.modules.setdefault("twitchio.ext.commands", _twitchio_ext_commands_mock)

from elizaos_plugin_twitch.types import (
    TwitchSendResult,
    TwitchSettings,
    TwitchUserInfo,
)


# ---------------------------------------------------------------------------
# Mock message class (mimics elizaOS Memory)
# ---------------------------------------------------------------------------


class MockContent(dict):
    """Dict subclass that also supports .get() for content access."""
    pass


class MockMessage:
    """Lightweight mock of an elizaOS Memory object."""

    def __init__(self, source: str = "twitch", text: str = "hello", metadata: Optional[dict] = None):
        self.content = MockContent(
            {"text": text, "source": source}
        )
        if metadata is not None:
            self.content["metadata"] = metadata

    def __repr__(self) -> str:
        return f"MockMessage(source={self.content.get('source')!r})"


# ---------------------------------------------------------------------------
# Mock runtime
# ---------------------------------------------------------------------------


class MockRuntime:
    """Lightweight mock of an elizaOS IAgentRuntime."""

    def __init__(
        self,
        *,
        service=None,
        model_response: str = "{}",
        settings: Optional[dict[str, str]] = None,
    ):
        self._service = service
        self._model_response = model_response
        self._settings = settings or {}

    def get_service(self, name: str):
        return self._service

    def get_setting(self, key: str) -> Optional[str]:
        return self._settings.get(key)

    async def use_model(self, model_type: str, opts: dict) -> str:
        return self._model_response

    async def compose_state(self, message) -> dict:
        return {"recentMessages": ""}

    async def emit_event(self, event_type: str, payload: dict) -> None:
        pass


# ---------------------------------------------------------------------------
# Mock Twitch service
# ---------------------------------------------------------------------------


class MockTwitchService:
    """Standalone mock of TwitchService for provider / action tests."""

    def __init__(
        self,
        *,
        connected: bool = True,
        bot_username: str = "testbot",
        primary_channel: str = "mainchannel",
        joined_channels: Optional[list[str]] = None,
        send_result: Optional[TwitchSendResult] = None,
    ):
        self._connected = connected
        self._bot_username = bot_username
        self._primary_channel = primary_channel
        self._joined_channels = joined_channels if joined_channels is not None else ["mainchannel"]
        self._send_result = send_result or TwitchSendResult(success=True, message_id="msg-123")
        self.join_channel = AsyncMock()
        self.leave_channel = AsyncMock()

    def is_connected(self) -> bool:
        return self._connected

    def get_bot_username(self) -> str:
        return self._bot_username

    def get_primary_channel(self) -> str:
        return self._primary_channel

    def get_joined_channels(self) -> list[str]:
        return list(self._joined_channels)

    async def send_message(self, text, options=None) -> TwitchSendResult:
        return self._send_result


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def mock_runtime():
    """Return a factory for MockRuntime."""
    def _factory(**kwargs):
        return MockRuntime(**kwargs)
    return _factory


@pytest.fixture
def mock_service():
    """Return a factory for MockTwitchService."""
    def _factory(**kwargs):
        return MockTwitchService(**kwargs)
    return _factory


@pytest.fixture
def twitch_message():
    """Return a factory for MockMessage with twitch source."""
    def _factory(text: str = "hello", source: str = "twitch", metadata: Optional[dict] = None):
        return MockMessage(source=source, text=text, metadata=metadata)
    return _factory


@pytest.fixture
def sample_user_info():
    """Return a sample TwitchUserInfo."""
    return TwitchUserInfo(
        user_id="12345",
        username="testuser",
        display_name="TestUser",
        is_moderator=False,
        is_broadcaster=False,
        is_vip=False,
        is_subscriber=False,
    )


@pytest.fixture
def broadcaster_user_info():
    """Return a TwitchUserInfo for a broadcaster."""
    return TwitchUserInfo(
        user_id="99",
        username="streamer",
        display_name="Streamer",
        is_moderator=False,
        is_broadcaster=True,
        is_vip=False,
        is_subscriber=True,
    )


@pytest.fixture
def moderator_user_info():
    """Return a TwitchUserInfo for a moderator."""
    return TwitchUserInfo(
        user_id="55",
        username="modperson",
        display_name="ModPerson",
        is_moderator=True,
        is_broadcaster=False,
        is_vip=False,
        is_subscriber=False,
    )
