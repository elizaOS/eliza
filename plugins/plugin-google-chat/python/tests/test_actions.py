"""Tests for Google Chat plugin actions."""

from elizaos_plugin_google_chat.actions import (
    list_spaces_action,
    send_message_action,
    send_reaction_action,
)
from elizaos_plugin_google_chat.actions.list_spaces import validate as validate_list_spaces
from elizaos_plugin_google_chat.actions.send_message import validate as validate_send_message
from elizaos_plugin_google_chat.actions.send_reaction import validate as validate_send_reaction


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


class TestSendMessageAction:
    def test_action_name(self):
        assert send_message_action["name"] == "GOOGLE_CHAT_SEND_MESSAGE"

    def test_action_similes(self):
        similes = send_message_action["similes"]
        assert "SEND_GOOGLE_CHAT_MESSAGE" in similes
        assert "MESSAGE_GOOGLE_CHAT" in similes
        assert "GCHAT_SEND" in similes
        assert "GOOGLE_CHAT_TEXT" in similes

    def test_action_description(self):
        assert len(send_message_action["description"]) > 0

    def test_action_examples(self):
        assert len(send_message_action["examples"]) > 0

    def test_action_has_handler(self):
        assert callable(send_message_action["handler"])

    def test_action_has_validate(self):
        assert callable(send_message_action["validate"])


class TestSendMessageValidate:
    async def test_google_chat_source(self):
        result = await validate_send_message(None, _MockMessage("google-chat"))
        assert result is True

    async def test_non_google_chat_source(self):
        result = await validate_send_message(None, _MockMessage("telegram"))
        assert result is False

    async def test_discord_source(self):
        result = await validate_send_message(None, _MockMessage("discord"))
        assert result is False

    async def test_no_source(self):
        result = await validate_send_message(None, _MockMessage())
        assert result is False


class TestSendReactionAction:
    def test_action_name(self):
        assert send_reaction_action["name"] == "GOOGLE_CHAT_SEND_REACTION"

    def test_action_similes(self):
        similes = send_reaction_action["similes"]
        assert "REACT_GOOGLE_CHAT" in similes
        assert "GCHAT_REACT" in similes
        assert "GOOGLE_CHAT_EMOJI" in similes
        assert "ADD_GOOGLE_CHAT_REACTION" in similes

    def test_action_description(self):
        assert len(send_reaction_action["description"]) > 0

    def test_action_examples(self):
        assert len(send_reaction_action["examples"]) > 0


class TestSendReactionValidate:
    async def test_google_chat_source(self):
        result = await validate_send_reaction(None, _MockMessage("google-chat"))
        assert result is True

    async def test_non_google_chat_source(self):
        result = await validate_send_reaction(None, _MockMessage("slack"))
        assert result is False

    async def test_no_source(self):
        result = await validate_send_reaction(None, _MockMessage())
        assert result is False


class TestListSpacesAction:
    def test_action_name(self):
        assert list_spaces_action["name"] == "GOOGLE_CHAT_LIST_SPACES"

    def test_action_similes(self):
        similes = list_spaces_action["similes"]
        assert "LIST_GOOGLE_CHAT_SPACES" in similes
        assert "GCHAT_SPACES" in similes
        assert "SHOW_GOOGLE_CHAT_SPACES" in similes

    def test_action_description(self):
        assert len(list_spaces_action["description"]) > 0

    def test_action_examples(self):
        assert len(list_spaces_action["examples"]) > 0


class TestListSpacesValidate:
    async def test_google_chat_source(self):
        result = await validate_list_spaces(None, _MockMessage("google-chat"))
        assert result is True

    async def test_non_google_chat_source(self):
        result = await validate_list_spaces(None, _MockMessage("feishu"))
        assert result is False

    async def test_no_source(self):
        result = await validate_list_spaces(None, _MockMessage())
        assert result is False
