"""Tests for LINE plugin providers."""

from elizaos_plugin_line.providers import chat_context_provider, user_context_provider

# ---------------------------------------------------------------------------
# Provider metadata
# ---------------------------------------------------------------------------


def test_user_context_provider_metadata():
    assert user_context_provider["name"] == "lineUserContext"
    assert "LINE user" in user_context_provider["description"]
    assert callable(user_context_provider["get"])


def test_chat_context_provider_metadata():
    assert chat_context_provider["name"] == "lineChatContext"
    assert "LINE chat" in chat_context_provider["description"]
    assert callable(chat_context_provider["get"])


# ---------------------------------------------------------------------------
# Provider output (non-LINE source)
# ---------------------------------------------------------------------------


class MockMessage:
    """Mock message for testing."""

    def __init__(self, source: str = "line"):
        self.content = {"source": source}


class MockRuntime:
    """Mock runtime that returns no service."""

    def get_service(self, name: str):
        return None


import pytest


@pytest.mark.asyncio
async def test_user_context_non_line_source():
    """User context should return empty for non-LINE messages."""
    msg = MockMessage(source="discord")
    result = await user_context_provider["get"](MockRuntime(), msg, {})
    assert result["text"] == ""
    assert result["data"] == {}


@pytest.mark.asyncio
async def test_chat_context_non_line_source():
    """Chat context should return empty for non-LINE messages."""
    msg = MockMessage(source="discord")
    result = await chat_context_provider["get"](MockRuntime(), msg, {})
    assert result["text"] == ""
    assert result["data"] == {}


@pytest.mark.asyncio
async def test_user_context_no_service():
    """User context should return disconnected when service unavailable."""
    msg = MockMessage(source="line")
    result = await user_context_provider["get"](MockRuntime(), msg, {})
    assert result["data"]["connected"] is False


@pytest.mark.asyncio
async def test_chat_context_no_service():
    """Chat context should return disconnected when service unavailable."""
    msg = MockMessage(source="line")
    result = await chat_context_provider["get"](MockRuntime(), msg, {})
    assert result["data"]["connected"] is False


# ---------------------------------------------------------------------------
# Provider output with mock service
# ---------------------------------------------------------------------------


class MockLineService:
    """Mock LINE service for testing providers."""

    def is_connected(self) -> bool:
        return True

    async def get_user_profile(self, user_id: str):
        if user_id == "U_KNOWN":
            from elizaos_plugin_line.types import LineUser

            return LineUser(
                user_id="U_KNOWN",
                display_name="Known User",
                language="ja",
                status_message="Hello!",
            )
        return None

    async def get_group_info(self, group_id: str):
        if group_id == "C_GROUP":
            from elizaos_plugin_line.types import LineGroup

            return LineGroup(
                group_id="C_GROUP",
                group_type="group",
                group_name="Test Group",
                member_count=10,
            )
        return None


class MockRuntimeWithService:
    def get_service(self, name: str):
        return MockLineService()


@pytest.mark.asyncio
async def test_user_context_with_profile():
    """User context should include profile data when available."""
    msg = MockMessage(source="line")
    state = {"agentName": "TestBot", "data": {"userId": "U_KNOWN"}}
    result = await user_context_provider["get"](MockRuntimeWithService(), msg, state)

    assert result["data"]["connected"] is True
    assert result["data"]["display_name"] == "Known User"
    assert result["data"]["language"] == "ja"
    assert "Known User" in result["text"]
    assert "Hello!" in result["text"]


@pytest.mark.asyncio
async def test_user_context_unknown_user():
    """User context should handle unknown users gracefully."""
    msg = MockMessage(source="line")
    state = {"agentName": "TestBot", "data": {"userId": "U_UNKNOWN"}}
    result = await user_context_provider["get"](MockRuntimeWithService(), msg, state)

    assert result["data"]["connected"] is True
    assert "U_UNKNOW" in result["text"]


@pytest.mark.asyncio
async def test_chat_context_dm():
    """Chat context should identify DM conversations."""
    msg = MockMessage(source="line")
    state = {"agentName": "TestBot", "data": {"userId": "U123"}}
    result = await chat_context_provider["get"](MockRuntimeWithService(), msg, state)

    assert result["data"]["chat_type"] == "user"
    assert "direct message" in result["text"]


@pytest.mark.asyncio
async def test_chat_context_group():
    """Chat context should include group info."""
    msg = MockMessage(source="line")
    state = {"agentName": "TestBot", "data": {"userId": "U123", "groupId": "C_GROUP"}}
    result = await chat_context_provider["get"](MockRuntimeWithService(), msg, state)

    assert result["data"]["chat_type"] == "group"
    assert result["data"]["chat_name"] == "Test Group"
    assert result["data"]["member_count"] == 10
    assert "Test Group" in result["text"]
    assert "10 members" in result["text"]


@pytest.mark.asyncio
async def test_chat_context_room():
    """Chat context should identify room conversations."""
    msg = MockMessage(source="line")
    state = {"agentName": "TestBot", "data": {"userId": "U123", "roomId": "R456"}}
    result = await chat_context_provider["get"](MockRuntimeWithService(), msg, state)

    assert result["data"]["chat_type"] == "room"
    assert "chat room" in result["text"]
