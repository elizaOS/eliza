"""
Tests for all 11 Slack plugin actions.

Each action is tested for:
  - Metadata correctness (name, similes, description, handler, validate)
  - validate() returns True for slack-sourced messages
  - validate() returns False for non-slack messages
"""

import pytest
from unittest.mock import AsyncMock, MagicMock

from elizaos_plugin_slack.actions.send_message import send_message
from elizaos_plugin_slack.actions.react_to_message import react_to_message
from elizaos_plugin_slack.actions.read_channel import read_channel
from elizaos_plugin_slack.actions.edit_message import edit_message
from elizaos_plugin_slack.actions.delete_message import delete_message
from elizaos_plugin_slack.actions.pin_message import pin_message
from elizaos_plugin_slack.actions.unpin_message import unpin_message
from elizaos_plugin_slack.actions.list_channels import list_channels
from elizaos_plugin_slack.actions.get_user_info import get_user_info
from elizaos_plugin_slack.actions.list_pins import list_pins
from elizaos_plugin_slack.actions.emoji_list import emoji_list


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

ALL_ACTIONS = [
    send_message,
    react_to_message,
    read_channel,
    edit_message,
    delete_message,
    pin_message,
    unpin_message,
    list_channels,
    get_user_info,
    list_pins,
    emoji_list,
]

EXPECTED_METADATA = {
    "SLACK_SEND_MESSAGE": {
        "similes": ["SEND_SLACK_MESSAGE", "POST_TO_SLACK", "MESSAGE_SLACK", "SLACK_POST"],
        "description": "Send a message to a Slack channel or thread",
    },
    "SLACK_REACT_TO_MESSAGE": {
        "similes": ["ADD_SLACK_REACTION", "REACT_SLACK", "SLACK_EMOJI"],
        "description": "Add or remove an emoji reaction to a Slack message",
    },
    "SLACK_READ_CHANNEL": {
        "similes": ["READ_SLACK_MESSAGES", "GET_CHANNEL_HISTORY", "SLACK_HISTORY"],
        "description": "Read message history from a Slack channel",
    },
    "SLACK_EDIT_MESSAGE": {
        "similes": ["UPDATE_SLACK_MESSAGE", "MODIFY_MESSAGE", "CHANGE_MESSAGE"],
        "description": "Edit an existing Slack message",
    },
    "SLACK_DELETE_MESSAGE": {
        "similes": ["REMOVE_SLACK_MESSAGE", "DELETE_MESSAGE", "SLACK_REMOVE"],
        "description": "Delete a Slack message",
    },
    "SLACK_PIN_MESSAGE": {
        "similes": ["PIN_SLACK_MESSAGE", "PIN_MESSAGE", "SLACK_PIN"],
        "description": "Pin a message in a Slack channel",
    },
    "SLACK_UNPIN_MESSAGE": {
        "similes": ["UNPIN_SLACK_MESSAGE", "UNPIN_MESSAGE", "SLACK_UNPIN"],
        "description": "Unpin a message from a Slack channel",
    },
    "SLACK_LIST_CHANNELS": {
        "similes": ["LIST_SLACK_CHANNELS", "SHOW_CHANNELS", "GET_CHANNELS"],
        "description": "List available Slack channels in the workspace",
    },
    "SLACK_GET_USER_INFO": {
        "similes": ["GET_SLACK_USER", "USER_INFO", "SLACK_USER", "WHO_IS"],
        "description": "Get information about a Slack user",
    },
    "SLACK_LIST_PINS": {
        "similes": ["LIST_SLACK_PINS", "SHOW_PINS", "GET_PINNED_MESSAGES"],
        "description": "List pinned messages in a Slack channel",
    },
    "SLACK_EMOJI_LIST": {
        "similes": ["LIST_SLACK_EMOJI", "SHOW_EMOJI", "GET_CUSTOM_EMOJI"],
        "description": "List custom emoji available in the Slack workspace",
    },
}


# ===================================================================
# Metadata tests – parametrized over every action
# ===================================================================

class TestActionMetadata:
    """Verify that every action exports the required metadata keys."""

    @pytest.mark.parametrize("action", ALL_ACTIONS, ids=[a["name"] for a in ALL_ACTIONS])
    def test_has_required_keys(self, action):
        for key in ("name", "similes", "description", "validate", "handler", "examples"):
            assert key in action, f"{action['name']} missing key '{key}'"

    @pytest.mark.parametrize("action", ALL_ACTIONS, ids=[a["name"] for a in ALL_ACTIONS])
    def test_name_is_string_and_nonempty(self, action):
        assert isinstance(action["name"], str)
        assert len(action["name"]) > 0

    @pytest.mark.parametrize("action", ALL_ACTIONS, ids=[a["name"] for a in ALL_ACTIONS])
    def test_name_matches_expected(self, action):
        assert action["name"] in EXPECTED_METADATA

    @pytest.mark.parametrize("action", ALL_ACTIONS, ids=[a["name"] for a in ALL_ACTIONS])
    def test_similes_match(self, action):
        expected = EXPECTED_METADATA[action["name"]]["similes"]
        assert action["similes"] == expected

    @pytest.mark.parametrize("action", ALL_ACTIONS, ids=[a["name"] for a in ALL_ACTIONS])
    def test_description_matches(self, action):
        expected = EXPECTED_METADATA[action["name"]]["description"]
        assert action["description"] == expected

    @pytest.mark.parametrize("action", ALL_ACTIONS, ids=[a["name"] for a in ALL_ACTIONS])
    def test_similes_is_list_of_strings(self, action):
        assert isinstance(action["similes"], list)
        for s in action["similes"]:
            assert isinstance(s, str)
            assert len(s) > 0

    @pytest.mark.parametrize("action", ALL_ACTIONS, ids=[a["name"] for a in ALL_ACTIONS])
    def test_similes_not_empty(self, action):
        assert len(action["similes"]) >= 1

    @pytest.mark.parametrize("action", ALL_ACTIONS, ids=[a["name"] for a in ALL_ACTIONS])
    def test_handler_is_callable(self, action):
        assert callable(action["handler"])

    @pytest.mark.parametrize("action", ALL_ACTIONS, ids=[a["name"] for a in ALL_ACTIONS])
    def test_validate_is_callable(self, action):
        assert callable(action["validate"])

    @pytest.mark.parametrize("action", ALL_ACTIONS, ids=[a["name"] for a in ALL_ACTIONS])
    def test_examples_is_list(self, action):
        assert isinstance(action["examples"], list)
        assert len(action["examples"]) >= 1

    def test_all_11_actions_present(self):
        names = {a["name"] for a in ALL_ACTIONS}
        assert len(names) == 11
        assert names == set(EXPECTED_METADATA.keys())


# ===================================================================
# validate() tests – parametrized over every action
# ===================================================================

class TestActionValidate:
    """Ensure validate() gates on message source."""

    @pytest.mark.parametrize("action", ALL_ACTIONS, ids=[a["name"] for a in ALL_ACTIONS])
    @pytest.mark.asyncio
    async def test_validate_returns_true_for_slack_source(self, action, mock_runtime, slack_message):
        result = await action["validate"](mock_runtime, slack_message)
        assert result is True

    @pytest.mark.parametrize("action", ALL_ACTIONS, ids=[a["name"] for a in ALL_ACTIONS])
    @pytest.mark.asyncio
    async def test_validate_returns_false_for_non_slack_source(self, action, mock_runtime, non_slack_message):
        result = await action["validate"](mock_runtime, non_slack_message)
        assert result is False

    @pytest.mark.parametrize("action", ALL_ACTIONS, ids=[a["name"] for a in ALL_ACTIONS])
    @pytest.mark.asyncio
    async def test_validate_returns_false_for_empty_source(self, action, mock_runtime):
        msg = MagicMock()
        msg.content = {"text": "no source key"}
        result = await action["validate"](mock_runtime, msg)
        assert result is False

    @pytest.mark.parametrize("action", ALL_ACTIONS, ids=[a["name"] for a in ALL_ACTIONS])
    @pytest.mark.asyncio
    async def test_validate_returns_false_for_none_source(self, action, mock_runtime):
        msg = MagicMock()
        msg.content = {"source": None}
        result = await action["validate"](mock_runtime, msg)
        assert result is False


# ===================================================================
# Handler tests – individual action-specific behaviour
# ===================================================================

class TestSendMessageHandler:
    @pytest.mark.asyncio
    async def test_success(self, mock_runtime, slack_message, mock_state, mock_callback):
        options = {"text": "Hello!", "channel_ref": "current"}
        result = await send_message["handler"](mock_runtime, slack_message, mock_state, options, mock_callback)
        assert result["success"] is True
        assert "data" in result
        assert result["data"]["message_ts"] == "1700000000.000099"
        mock_callback.assert_called()

    @pytest.mark.asyncio
    async def test_no_text(self, mock_runtime, slack_message, mock_state, mock_callback):
        options = {}
        result = await send_message["handler"](mock_runtime, slack_message, mock_state, options, mock_callback)
        assert result["success"] is False
        assert "error" in result

    @pytest.mark.asyncio
    async def test_service_unavailable(self, mock_runtime, slack_message, mock_state, mock_callback):
        mock_runtime.get_service.return_value = None
        result = await send_message["handler"](mock_runtime, slack_message, mock_state, options={"text": "hi"}, callback=mock_callback)
        assert result["success"] is False


class TestReactToMessageHandler:
    @pytest.mark.asyncio
    async def test_missing_emoji(self, mock_runtime, slack_message, mock_state, mock_callback):
        options = {"message_ts": "1700000000.000001"}
        result = await react_to_message["handler"](mock_runtime, slack_message, mock_state, options, mock_callback)
        assert result["success"] is False

    @pytest.mark.asyncio
    async def test_missing_message_ts(self, mock_runtime, slack_message, mock_state, mock_callback):
        options = {"emoji": "thumbsup"}
        result = await react_to_message["handler"](mock_runtime, slack_message, mock_state, options, mock_callback)
        assert result["success"] is False

    @pytest.mark.asyncio
    async def test_invalid_message_ts(self, mock_runtime, slack_message, mock_state, mock_callback):
        options = {"emoji": "thumbsup", "message_ts": "bad-ts"}
        result = await react_to_message["handler"](mock_runtime, slack_message, mock_state, options, mock_callback)
        assert result["success"] is False

    @pytest.mark.asyncio
    async def test_service_unavailable(self, mock_runtime, slack_message, mock_state, mock_callback):
        mock_runtime.get_service.return_value = None
        options = {"emoji": "thumbsup", "message_ts": "1700000000.000001"}
        result = await react_to_message["handler"](mock_runtime, slack_message, mock_state, options, mock_callback)
        assert result["success"] is False


class TestEditMessageHandler:
    @pytest.mark.asyncio
    async def test_missing_params(self, mock_runtime, slack_message, mock_state, mock_callback):
        result = await edit_message["handler"](mock_runtime, slack_message, mock_state, {}, mock_callback)
        assert result["success"] is False

    @pytest.mark.asyncio
    async def test_invalid_ts(self, mock_runtime, slack_message, mock_state, mock_callback):
        options = {"message_ts": "bad", "new_text": "updated"}
        result = await edit_message["handler"](mock_runtime, slack_message, mock_state, options, mock_callback)
        assert result["success"] is False

    @pytest.mark.asyncio
    async def test_service_unavailable(self, mock_runtime, slack_message, mock_state, mock_callback):
        mock_runtime.get_service.return_value = None
        options = {"message_ts": "1700000000.000001", "new_text": "updated"}
        result = await edit_message["handler"](mock_runtime, slack_message, mock_state, options, mock_callback)
        assert result["success"] is False


class TestDeleteMessageHandler:
    @pytest.mark.asyncio
    async def test_missing_ts(self, mock_runtime, slack_message, mock_state, mock_callback):
        result = await delete_message["handler"](mock_runtime, slack_message, mock_state, {}, mock_callback)
        assert result["success"] is False

    @pytest.mark.asyncio
    async def test_invalid_ts(self, mock_runtime, slack_message, mock_state, mock_callback):
        options = {"message_ts": "nope"}
        result = await delete_message["handler"](mock_runtime, slack_message, mock_state, options, mock_callback)
        assert result["success"] is False

    @pytest.mark.asyncio
    async def test_service_unavailable(self, mock_runtime, slack_message, mock_state, mock_callback):
        mock_runtime.get_service.return_value = None
        options = {"message_ts": "1700000000.000001"}
        result = await delete_message["handler"](mock_runtime, slack_message, mock_state, options, mock_callback)
        assert result["success"] is False


class TestPinMessageHandler:
    @pytest.mark.asyncio
    async def test_missing_ts(self, mock_runtime, slack_message, mock_state, mock_callback):
        result = await pin_message["handler"](mock_runtime, slack_message, mock_state, {}, mock_callback)
        assert result["success"] is False

    @pytest.mark.asyncio
    async def test_invalid_ts(self, mock_runtime, slack_message, mock_state, mock_callback):
        options = {"message_ts": "invalid"}
        result = await pin_message["handler"](mock_runtime, slack_message, mock_state, options, mock_callback)
        assert result["success"] is False

    @pytest.mark.asyncio
    async def test_service_unavailable(self, mock_runtime, slack_message, mock_state, mock_callback):
        mock_runtime.get_service.return_value = None
        options = {"message_ts": "1700000000.000001"}
        result = await pin_message["handler"](mock_runtime, slack_message, mock_state, options, mock_callback)
        assert result["success"] is False


class TestUnpinMessageHandler:
    @pytest.mark.asyncio
    async def test_missing_ts(self, mock_runtime, slack_message, mock_state, mock_callback):
        result = await unpin_message["handler"](mock_runtime, slack_message, mock_state, {}, mock_callback)
        assert result["success"] is False

    @pytest.mark.asyncio
    async def test_invalid_ts(self, mock_runtime, slack_message, mock_state, mock_callback):
        options = {"message_ts": "invalid"}
        result = await unpin_message["handler"](mock_runtime, slack_message, mock_state, options, mock_callback)
        assert result["success"] is False

    @pytest.mark.asyncio
    async def test_service_unavailable(self, mock_runtime, slack_message, mock_state, mock_callback):
        mock_runtime.get_service.return_value = None
        options = {"message_ts": "1700000000.000001"}
        result = await unpin_message["handler"](mock_runtime, slack_message, mock_state, options, mock_callback)
        assert result["success"] is False


class TestListChannelsHandler:
    @pytest.mark.asyncio
    async def test_service_unavailable(self, mock_runtime, slack_message, mock_state, mock_callback):
        mock_runtime.get_service.return_value = None
        result = await list_channels["handler"](mock_runtime, slack_message, mock_state, {}, mock_callback)
        assert result["success"] is False

    @pytest.mark.asyncio
    async def test_success_returns_channel_data(self, mock_runtime, slack_message, mock_state, mock_callback):
        result = await list_channels["handler"](mock_runtime, slack_message, mock_state, {}, mock_callback)
        assert result["success"] is True
        assert "data" in result
        assert "channel_count" in result["data"]
        assert isinstance(result["data"]["channels"], list)


class TestGetUserInfoHandler:
    @pytest.mark.asyncio
    async def test_missing_user_id(self, mock_runtime, slack_message, mock_state, mock_callback):
        result = await get_user_info["handler"](mock_runtime, slack_message, mock_state, {}, mock_callback)
        assert result["success"] is False

    @pytest.mark.asyncio
    async def test_invalid_user_id(self, mock_runtime, slack_message, mock_state, mock_callback):
        options = {"user_id": "not-a-valid-id"}
        result = await get_user_info["handler"](mock_runtime, slack_message, mock_state, options, mock_callback)
        assert result["success"] is False

    @pytest.mark.asyncio
    async def test_valid_user_id_returns_data(self, mock_runtime, slack_message, mock_state, mock_callback):
        options = {"user_id": "U0123456789"}
        result = await get_user_info["handler"](mock_runtime, slack_message, mock_state, options, mock_callback)
        assert result["success"] is True
        assert result["data"]["user_id"] == "U0123456789"
        assert result["data"]["display_name"] == "janesmith"

    @pytest.mark.asyncio
    async def test_service_unavailable(self, mock_runtime, slack_message, mock_state, mock_callback):
        mock_runtime.get_service.return_value = None
        options = {"user_id": "U0123456789"}
        result = await get_user_info["handler"](mock_runtime, slack_message, mock_state, options, mock_callback)
        assert result["success"] is False


class TestListPinsHandler:
    @pytest.mark.asyncio
    async def test_service_unavailable(self, mock_runtime, slack_message, mock_state, mock_callback):
        mock_runtime.get_service.return_value = None
        result = await list_pins["handler"](mock_runtime, slack_message, mock_state, {}, mock_callback)
        assert result["success"] is False

    @pytest.mark.asyncio
    async def test_success_returns_pin_data(self, mock_runtime, slack_message, mock_state, mock_callback):
        result = await list_pins["handler"](mock_runtime, slack_message, mock_state, {}, mock_callback)
        assert result["success"] is True
        assert "data" in result
        assert result["data"]["pin_count"] >= 1


class TestEmojiListHandler:
    @pytest.mark.asyncio
    async def test_service_unavailable(self, mock_runtime, slack_message, mock_state, mock_callback):
        mock_runtime.get_service.return_value = None
        result = await emoji_list["handler"](mock_runtime, slack_message, mock_state, {}, mock_callback)
        assert result["success"] is False

    @pytest.mark.asyncio
    async def test_success_returns_emoji_data(self, mock_runtime, slack_message, mock_state, mock_callback):
        result = await emoji_list["handler"](mock_runtime, slack_message, mock_state, {}, mock_callback)
        assert result["success"] is True
        assert result["data"]["emoji_count"] == 2

    @pytest.mark.asyncio
    async def test_empty_emoji_list(self, mock_runtime, slack_message, mock_state, mock_callback, mock_slack_service):
        mock_slack_service.get_emoji_list.return_value = {}
        result = await emoji_list["handler"](mock_runtime, slack_message, mock_state, {}, mock_callback)
        assert result["success"] is True
        assert result["data"]["emoji_count"] == 0


class TestReadChannelHandler:
    @pytest.mark.asyncio
    async def test_service_unavailable(self, mock_runtime, slack_message, mock_state, mock_callback):
        mock_runtime.get_service.return_value = None
        result = await read_channel["handler"](mock_runtime, slack_message, mock_state, {}, mock_callback)
        assert result["success"] is False

    @pytest.mark.asyncio
    async def test_success_returns_messages(self, mock_runtime, slack_message, mock_state, mock_callback):
        result = await read_channel["handler"](mock_runtime, slack_message, mock_state, {}, mock_callback)
        assert result["success"] is True
        assert result["data"]["message_count"] >= 1
        assert isinstance(result["data"]["messages"], list)
