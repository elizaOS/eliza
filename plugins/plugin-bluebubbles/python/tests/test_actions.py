"""Tests for BlueBubbles action handlers."""

from unittest.mock import AsyncMock, MagicMock

import pytest

from elizaos_plugin_bluebubbles.actions.send_message import (
    handler as send_message_handler,
)
from elizaos_plugin_bluebubbles.actions.send_message import (
    send_message_action,
)
from elizaos_plugin_bluebubbles.actions.send_message import (
    validate as send_message_validate,
)
from elizaos_plugin_bluebubbles.actions.send_reaction import (
    _validate_reaction,
    send_reaction_action,
    send_reaction_handler,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_runtime(*, service=None):
    """Create a mock runtime with an optional BlueBubbles service."""
    rt = MagicMock()
    rt.get_service = MagicMock(return_value=service)
    return rt


def _make_bb_service(*, is_running=True, is_connected=True, send_guid="msg-guid-123"):
    """Create a mock BlueBubbles service."""
    svc = AsyncMock()
    svc.is_running = is_running
    svc.is_connected = MagicMock(return_value=is_connected)

    svc.send_message = AsyncMock(return_value=send_guid)
    svc.send_reaction = AsyncMock(
        return_value=MagicMock(success=True, error=None)
    )

    return svc


def _make_room(channel_id="chat_guid:iMessage;-;+15551234567"):
    """Create a mock room."""
    room = MagicMock()
    room.channel_id = channel_id
    return room


def _make_memory(text="Hello world", room_id="room-1", in_reply_to=None, source="bluebubbles"):
    """Create a mock Memory object."""
    mem = MagicMock()
    mem.room_id = room_id
    mem.content = MagicMock()
    mem.content.text = text
    mem.content.in_reply_to = in_reply_to
    mem.content.source = source
    return mem


# ---------------------------------------------------------------------------
# send_message – validate
# ---------------------------------------------------------------------------

class TestSendMessageValidate:
    """Tests for send_message_action.validate."""

    @pytest.mark.asyncio
    async def test_valid_when_service_present_and_running(self):
        svc = _make_bb_service()
        rt = _make_runtime(service=svc)
        msg = _make_memory()
        assert await send_message_validate(rt, msg) is True

    @pytest.mark.asyncio
    async def test_invalid_when_service_missing(self):
        rt = _make_runtime(service=None)
        msg = _make_memory()
        assert await send_message_validate(rt, msg) is False

    @pytest.mark.asyncio
    async def test_invalid_when_service_not_running(self):
        svc = _make_bb_service(is_running=False)
        rt = _make_runtime(service=svc)
        msg = _make_memory()
        assert await send_message_validate(rt, msg) is False


# ---------------------------------------------------------------------------
# send_message – handler
# ---------------------------------------------------------------------------

class TestSendMessageHandler:
    """Tests for send_message_action.handler."""

    @pytest.mark.asyncio
    async def test_successful_send(self):
        svc = _make_bb_service()
        rt = _make_runtime(service=svc)
        rt.get_room = AsyncMock(return_value=_make_room())
        msg = _make_memory(text="Hello from agent!")

        result = await send_message_handler(rt, msg)

        assert result is not None
        assert result.text == "Hello from agent!"
        assert result.source == "bluebubbles"
        svc.send_message.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_returns_none_when_service_unavailable(self):
        svc = _make_bb_service(is_running=False)
        rt = _make_runtime(service=svc)
        callback = MagicMock()

        result = await send_message_handler(rt, _make_memory(), callback=callback)

        assert result is None
        callback.assert_called_once()

    @pytest.mark.asyncio
    async def test_returns_none_when_no_room(self):
        svc = _make_bb_service()
        rt = _make_runtime(service=svc)
        rt.get_room = AsyncMock(return_value=None)
        callback = MagicMock()

        result = await send_message_handler(rt, _make_memory(), callback=callback)

        assert result is None
        callback.assert_called_once()

    @pytest.mark.asyncio
    async def test_returns_none_for_empty_text(self):
        svc = _make_bb_service()
        rt = _make_runtime(service=svc)
        rt.get_room = AsyncMock(return_value=_make_room())

        result = await send_message_handler(rt, _make_memory(text=""))

        assert result is None

    @pytest.mark.asyncio
    async def test_returns_none_for_whitespace_text(self):
        svc = _make_bb_service()
        rt = _make_runtime(service=svc)
        rt.get_room = AsyncMock(return_value=_make_room())

        result = await send_message_handler(rt, _make_memory(text="   "))

        assert result is None


# ---------------------------------------------------------------------------
# send_reaction – validate
# ---------------------------------------------------------------------------

class TestSendReactionValidate:
    """Tests for send_reaction validate."""

    def test_accepts_bluebubbles_source(self):
        msg = {"content": {"source": "bluebubbles"}}
        assert _validate_reaction(None, msg) is True

    def test_rejects_non_bluebubbles_source(self):
        msg = {"content": {"source": "discord"}}
        assert _validate_reaction(None, msg) is False

    def test_rejects_missing_source(self):
        msg = {"content": {}}
        assert _validate_reaction(None, msg) is False


# ---------------------------------------------------------------------------
# send_reaction – handler
# ---------------------------------------------------------------------------

class TestSendReactionHandler:
    """Tests for send_reaction_handler."""

    @pytest.mark.asyncio
    async def test_successful_reaction(self):
        svc = _make_bb_service()
        rt = _make_runtime(service=svc)
        msg = {"content": {"source": "bluebubbles"}}
        state = {"data": {"chatGuid": "iMessage;-;+15551234567", "lastMessageGuid": "msg-1"}}

        result = await send_reaction_handler(rt, msg, state=state)

        assert result["success"] is True
        assert result["data"]["emoji"] == "❤️"
        svc.send_reaction.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_fails_when_service_not_connected(self):
        svc = _make_bb_service(is_connected=False)
        rt = _make_runtime(service=svc)

        result = await send_reaction_handler(rt, {}, state=None)

        assert result["success"] is False
        assert "not available" in result["error"]

    @pytest.mark.asyncio
    async def test_fails_when_no_chat_guid(self):
        svc = _make_bb_service()
        rt = _make_runtime(service=svc)
        state = {"data": {"lastMessageGuid": "msg-1"}}

        result = await send_reaction_handler(rt, {}, state=state)

        assert result["success"] is False
        assert "chat" in result["error"].lower()

    @pytest.mark.asyncio
    async def test_fails_when_no_message_guid(self):
        svc = _make_bb_service()
        rt = _make_runtime(service=svc)
        state = {"data": {"chatGuid": "iMessage;-;+15551234567"}}

        result = await send_reaction_handler(rt, {}, state=state)

        assert result["success"] is False
        assert "message" in result["error"].lower()


# ---------------------------------------------------------------------------
# Action definition structure
# ---------------------------------------------------------------------------

class TestActionDefinitions:
    """Tests for action dict/object shapes."""

    def test_send_message_action_name(self):
        assert send_message_action.name == "SEND_BLUEBUBBLES_MESSAGE"

    def test_send_message_has_similes(self):
        assert len(send_message_action.similes) >= 3

    def test_send_reaction_action_name(self):
        assert send_reaction_action["name"] == "BLUEBUBBLES_SEND_REACTION"

    def test_send_reaction_has_similes(self):
        assert "BLUEBUBBLES_REACT" in send_reaction_action["similes"]

    def test_send_reaction_has_examples(self):
        assert len(send_reaction_action["examples"]) >= 1
