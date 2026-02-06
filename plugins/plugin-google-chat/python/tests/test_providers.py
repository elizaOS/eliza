"""Tests for Google Chat plugin providers."""

from elizaos_plugin_google_chat.providers import (
    space_state_provider,
    user_context_provider,
)
from elizaos_plugin_google_chat.providers.space_state import get_space_state
from elizaos_plugin_google_chat.providers.user_context import get_user_context


class _MockContent:
    """Lightweight mock for message content."""

    def __init__(self, source: str | None = None):
        self._data = {"source": source} if source else {}

    def get(self, key: str, default=None):
        return self._data.get(key, default)


class _MockMessage:
    """Lightweight mock for a message object."""

    def __init__(self, source: str | None = None):
        self.content = _MockContent(source)


class _MockService:
    """Lightweight mock for GoogleChatService."""

    def __init__(self, connected: bool = True):
        self._connected = connected

    def is_connected(self) -> bool:
        return self._connected


class _MockRuntime:
    """Lightweight mock for a runtime object."""

    def __init__(self, service: _MockService | None = None):
        self._service = service

    def get_service(self, name: str):
        return self._service


class TestSpaceStateProvider:
    def test_provider_name(self):
        assert space_state_provider["name"] == "googleChatSpaceState"

    def test_provider_description(self):
        assert len(space_state_provider["description"]) > 0

    def test_provider_has_get(self):
        assert callable(space_state_provider["get"])


class TestGetSpaceState:
    async def test_non_google_chat_source(self):
        result = await get_space_state(
            _MockRuntime(),
            _MockMessage("telegram"),
            {},
        )
        assert result["text"] == ""
        assert result["data"] == {}

    async def test_no_service(self):
        result = await get_space_state(
            _MockRuntime(service=None),
            _MockMessage("google-chat"),
            {},
        )
        assert result["data"]["connected"] is False

    async def test_disconnected_service(self):
        service = _MockService(connected=False)
        result = await get_space_state(
            _MockRuntime(service=service),
            _MockMessage("google-chat"),
            {},
        )
        assert result["data"]["connected"] is False

    async def test_dm_space(self):
        service = _MockService(connected=True)
        state = {
            "agentName": "TestBot",
            "data": {
                "space": {
                    "name": "spaces/DM_123",
                    "type": "DM",
                    "threaded": False,
                },
            },
        }
        result = await get_space_state(
            _MockRuntime(service=service),
            _MockMessage("google-chat"),
            state,
        )
        assert "TestBot" in result["text"]
        assert "direct message" in result["text"]
        assert result["data"]["is_direct"] is True
        assert result["data"]["connected"] is True

    async def test_regular_space(self):
        service = _MockService(connected=True)
        state = {
            "agentName": "AgentX",
            "data": {
                "space": {
                    "name": "spaces/SPACE_456",
                    "displayName": "Engineering",
                    "type": "SPACE",
                    "threaded": False,
                },
            },
        }
        result = await get_space_state(
            _MockRuntime(service=service),
            _MockMessage("google-chat"),
            state,
        )
        assert "AgentX" in result["text"]
        assert "Engineering" in result["text"]
        assert result["data"]["space_display_name"] == "Engineering"
        assert result["data"]["is_direct"] is False

    async def test_threaded_space(self):
        service = _MockService(connected=True)
        state = {
            "data": {
                "space": {
                    "name": "spaces/THREAD_789",
                    "displayName": "Threaded Room",
                    "type": "SPACE",
                    "threaded": True,
                },
            },
        }
        result = await get_space_state(
            _MockRuntime(service=service),
            _MockMessage("google-chat"),
            state,
        )
        assert "threaded" in result["text"]
        assert result["data"]["is_threaded"] is True

    async def test_bot_dm_via_flag(self):
        service = _MockService(connected=True)
        state = {
            "data": {
                "space": {
                    "name": "spaces/BOT_DM",
                    "type": "SPACE",
                    "singleUserBotDm": True,
                },
            },
        }
        result = await get_space_state(
            _MockRuntime(service=service),
            _MockMessage("google-chat"),
            state,
        )
        assert result["data"]["is_direct"] is True


class TestUserContextProvider:
    def test_provider_name(self):
        assert user_context_provider["name"] == "googleChatUserContext"

    def test_provider_description(self):
        assert len(user_context_provider["description"]) > 0

    def test_provider_has_get(self):
        assert callable(user_context_provider["get"])


class TestGetUserContext:
    async def test_non_google_chat_source(self):
        result = await get_user_context(
            _MockRuntime(),
            _MockMessage("discord"),
            {},
        )
        assert result["text"] == ""
        assert result["data"] == {}

    async def test_no_service(self):
        result = await get_user_context(
            _MockRuntime(service=None),
            _MockMessage("google-chat"),
            {},
        )
        assert result["data"]["connected"] is False

    async def test_no_sender_in_state(self):
        service = _MockService(connected=True)
        result = await get_user_context(
            _MockRuntime(service=service),
            _MockMessage("google-chat"),
            {"data": {}},
        )
        assert result["text"] == ""
        assert result["data"]["connected"] is True

    async def test_human_user(self):
        service = _MockService(connected=True)
        state = {
            "agentName": "TestBot",
            "data": {
                "sender": {
                    "name": "users/USER123",
                    "displayName": "Jane Doe",
                    "email": "jane@example.com",
                    "type": "HUMAN",
                },
            },
        }
        result = await get_user_context(
            _MockRuntime(service=service),
            _MockMessage("google-chat"),
            state,
        )
        assert "TestBot" in result["text"]
        assert "Jane Doe" in result["text"]
        assert "jane@example.com" in result["text"]
        assert "Google Chat" in result["text"]
        assert result["data"]["user_name"] == "users/USER123"
        assert result["data"]["user_id"] == "USER123"
        assert result["data"]["display_name"] == "Jane Doe"
        assert result["data"]["is_bot"] is False

    async def test_bot_user(self):
        service = _MockService(connected=True)
        state = {
            "agentName": "TestBot",
            "data": {
                "sender": {
                    "name": "users/BOT456",
                    "displayName": "Other Bot",
                    "type": "BOT",
                },
            },
        }
        result = await get_user_context(
            _MockRuntime(service=service),
            _MockMessage("google-chat"),
            state,
        )
        assert "bot" in result["text"].lower()
        assert result["data"]["is_bot"] is True
        assert result["data"]["user_type"] == "BOT"

    async def test_user_without_display_name(self):
        service = _MockService(connected=True)
        state = {
            "data": {
                "sender": {
                    "name": "users/NOIDUSER",
                },
            },
        }
        result = await get_user_context(
            _MockRuntime(service=service),
            _MockMessage("google-chat"),
            state,
        )
        assert result["data"]["display_name"] == "NOIDUSER"
        assert result["data"]["user_id"] == "NOIDUSER"
