"""
Tests for all four Signal plugin actions:
  - SIGNAL_SEND_MESSAGE
  - SIGNAL_SEND_REACTION
  - SIGNAL_LIST_CONTACTS
  - SIGNAL_LIST_GROUPS

Each action is tested for:
  - Metadata (name, similes, description, examples)
  - validate() – positive and negative inputs
  - handler() – happy paths, error branches, callback invocation
"""

import json

import pytest

from elizaos_plugin_signal.actions.send_message import (
    send_message_action,
    validate as send_message_validate,
    handler as send_message_handler,
)
from elizaos_plugin_signal.actions.send_reaction import (
    send_reaction_action,
    validate as send_reaction_validate,
    handler as send_reaction_handler,
)
from elizaos_plugin_signal.actions.list_contacts import (
    list_contacts_action,
    validate as list_contacts_validate,
    handler as list_contacts_handler,
)
from elizaos_plugin_signal.actions.list_groups import (
    list_groups_action,
    validate as list_groups_validate,
    handler as list_groups_handler,
)

from tests.conftest import MockMessage, MockRuntime, MockSignalService


# =========================================================================
# send_message_action
# =========================================================================


class TestSendMessageMetadata:
    """Verify action dict shape and contents."""

    def test_name(self):
        assert send_message_action["name"] == "SIGNAL_SEND_MESSAGE"

    def test_description_is_nonempty(self):
        assert len(send_message_action["description"]) > 10

    def test_similes_contains_expected_aliases(self):
        similes = send_message_action["similes"]
        assert "SEND_SIGNAL_MESSAGE" in similes
        assert "TEXT_SIGNAL" in similes
        assert "MESSAGE_SIGNAL" in similes
        assert "SIGNAL_TEXT" in similes

    def test_examples_is_nonempty_list(self):
        assert isinstance(send_message_action["examples"], list)
        assert len(send_message_action["examples"]) > 0

    def test_validate_and_handler_are_callables(self):
        assert callable(send_message_action["validate"])
        assert callable(send_message_action["handler"])


class TestSendMessageValidate:
    """validate() returns True only for signal-sourced messages."""

    @pytest.mark.asyncio
    async def test_accepts_signal_source(self):
        msg = MockMessage(source="signal")
        runtime = MockRuntime()
        assert await send_message_validate(runtime, msg) is True

    @pytest.mark.asyncio
    async def test_rejects_discord_source(self):
        msg = MockMessage(source="discord")
        runtime = MockRuntime()
        assert await send_message_validate(runtime, msg) is False

    @pytest.mark.asyncio
    async def test_rejects_empty_source(self):
        msg = MockMessage(source="")
        runtime = MockRuntime()
        assert await send_message_validate(runtime, msg) is False

    @pytest.mark.asyncio
    async def test_rejects_telegram_source(self):
        msg = MockMessage(source="telegram")
        runtime = MockRuntime()
        assert await send_message_validate(runtime, msg) is False


class TestSendMessageHandler:
    """handler() orchestrates LLM extraction and service calls."""

    @pytest.mark.asyncio
    async def test_returns_failure_when_service_unavailable(self):
        service = MockSignalService(connected=False)
        runtime = MockRuntime(service=service, room={"channel_id": "+1", "metadata": {}})
        msg = MockMessage(source="signal")
        callback = _AsyncRecorder()

        result = await send_message_handler(runtime, msg, {}, None, callback)

        assert result["success"] is False
        assert "not available" in result["error"].lower()
        assert callback.called
        assert "not available" in callback.last_payload["text"].lower()

    @pytest.mark.asyncio
    async def test_returns_failure_when_service_is_none(self):
        runtime = MockRuntime(service=None, room={"channel_id": "+1", "metadata": {}})
        msg = MockMessage(source="signal")
        callback = _AsyncRecorder()

        result = await send_message_handler(runtime, msg, {}, None, callback)

        assert result["success"] is False

    @pytest.mark.asyncio
    async def test_sends_dm_via_service(self):
        service = MockSignalService()
        llm_json = json.dumps({"text": "Hi there!", "recipient": "current"})
        room = {"channel_id": "+14155550101", "metadata": {"is_group": False}}
        runtime = MockRuntime(service=service, room=room, model_response=llm_json)
        msg = MockMessage(source="signal")
        callback = _AsyncRecorder()

        result = await send_message_handler(
            runtime, msg, {"recentMessages": ""}, None, callback,
        )

        assert result["success"] is True
        assert result["data"]["recipient"] == "+14155550101"
        service.send_message.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_sends_group_message_via_service(self):
        service = MockSignalService()
        group_id = "YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo="
        llm_json = json.dumps({"text": "Hello group!", "recipient": "current"})
        room = {
            "channel_id": group_id,
            "metadata": {"is_group": True},
        }
        runtime = MockRuntime(service=service, room=room, model_response=llm_json)
        msg = MockMessage(source="signal")

        result = await send_message_handler(
            runtime, msg, {"recentMessages": ""}, None, None,
        )

        assert result["success"] is True
        service.send_group_message.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_overrides_recipient_with_explicit_number(self):
        service = MockSignalService()
        llm_json = json.dumps({"text": "Ping", "recipient": "+14155559999"})
        room = {"channel_id": "+14155550101", "metadata": {"is_group": False}}
        runtime = MockRuntime(service=service, room=room, model_response=llm_json)
        msg = MockMessage(source="signal")

        result = await send_message_handler(
            runtime, msg, {"recentMessages": ""}, None, None,
        )

        assert result["success"] is True
        # The call should target the explicit number, not the room
        call_args = service.send_message.call_args
        assert "+14155559999" in str(call_args)

    @pytest.mark.asyncio
    async def test_returns_failure_when_llm_gives_bad_json(self):
        service = MockSignalService()
        room = {"channel_id": "+14155550101", "metadata": {}}
        runtime = MockRuntime(
            service=service,
            room=room,
            model_response="I don't understand",
        )
        msg = MockMessage(source="signal")
        callback = _AsyncRecorder()

        result = await send_message_handler(
            runtime, msg, {"recentMessages": ""}, None, callback,
        )

        assert result["success"] is False
        assert "could not extract" in result["error"].lower()

    @pytest.mark.asyncio
    async def test_returns_failure_when_room_is_none(self):
        service = MockSignalService()
        llm_json = json.dumps({"text": "Hello", "recipient": "current"})
        runtime = MockRuntime(service=service, room=None, model_response=llm_json)
        msg = MockMessage(source="signal")

        result = await send_message_handler(
            runtime, msg, {"recentMessages": ""}, None, None,
        )

        assert result["success"] is False
        assert "conversation" in result["error"].lower()


# =========================================================================
# send_reaction_action
# =========================================================================


class TestSendReactionMetadata:
    def test_name(self):
        assert send_reaction_action["name"] == "SIGNAL_SEND_REACTION"

    def test_description_mentions_emoji_or_react(self):
        desc = send_reaction_action["description"].lower()
        assert "react" in desc or "emoji" in desc

    def test_similes(self):
        similes = send_reaction_action["similes"]
        assert "REACT_SIGNAL" in similes
        assert "SIGNAL_REACT" in similes
        assert "ADD_SIGNAL_REACTION" in similes
        assert "SIGNAL_EMOJI" in similes

    def test_has_examples(self):
        assert len(send_reaction_action["examples"]) > 0


class TestSendReactionValidate:
    @pytest.mark.asyncio
    async def test_accepts_signal_source(self):
        msg = MockMessage(source="signal")
        assert await send_reaction_validate(MockRuntime(), msg) is True

    @pytest.mark.asyncio
    async def test_rejects_non_signal_source(self):
        msg = MockMessage(source="slack")
        assert await send_reaction_validate(MockRuntime(), msg) is False


class TestSendReactionHandler:
    @pytest.mark.asyncio
    async def test_returns_failure_when_service_unavailable(self):
        service = MockSignalService(connected=False)
        runtime = MockRuntime(service=service)
        msg = MockMessage(source="signal")
        callback = _AsyncRecorder()

        result = await send_reaction_handler(runtime, msg, {}, None, callback)

        assert result["success"] is False
        assert callback.called

    @pytest.mark.asyncio
    async def test_adds_reaction_successfully(self):
        service = MockSignalService()
        llm_json = json.dumps({
            "emoji": "👍",
            "targetTimestamp": 1700000000000,
            "targetAuthor": "+14155550101",
            "remove": False,
        })
        room = {"channel_id": "+14155550101", "metadata": {}}
        runtime = MockRuntime(service=service, room=room, model_response=llm_json)
        msg = MockMessage(source="signal")
        callback = _AsyncRecorder()

        result = await send_reaction_handler(
            runtime, msg, {"recentMessages": ""}, None, callback,
        )

        assert result["success"] is True
        assert result["data"]["emoji"] == "👍"
        assert result["data"]["action"] == "added"
        service.send_reaction.assert_awaited_once()
        service.remove_reaction.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_removes_reaction_when_flag_set(self):
        service = MockSignalService()
        llm_json = json.dumps({
            "emoji": "👎",
            "targetTimestamp": 1700000000000,
            "targetAuthor": "+14155550101",
            "remove": True,
        })
        room = {"channel_id": "+14155550101", "metadata": {}}
        runtime = MockRuntime(service=service, room=room, model_response=llm_json)
        msg = MockMessage(source="signal")

        result = await send_reaction_handler(
            runtime, msg, {"recentMessages": ""}, None, None,
        )

        assert result["success"] is True
        assert result["data"]["action"] == "removed"
        service.remove_reaction.assert_awaited_once()
        service.send_reaction.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_returns_failure_for_bad_llm_output(self):
        service = MockSignalService()
        room = {"channel_id": "+14155550101", "metadata": {}}
        runtime = MockRuntime(
            service=service, room=room, model_response="no json here",
        )
        msg = MockMessage(source="signal")
        callback = _AsyncRecorder()

        result = await send_reaction_handler(
            runtime, msg, {"recentMessages": ""}, None, callback,
        )

        assert result["success"] is False
        assert "could not extract" in result["error"].lower()


# =========================================================================
# list_contacts_action
# =========================================================================


class TestListContactsMetadata:
    def test_name(self):
        assert list_contacts_action["name"] == "SIGNAL_LIST_CONTACTS"

    def test_description_mentions_contacts(self):
        assert "contact" in list_contacts_action["description"].lower()

    def test_similes(self):
        similes = list_contacts_action["similes"]
        assert "LIST_SIGNAL_CONTACTS" in similes
        assert "SHOW_CONTACTS" in similes
        assert "GET_CONTACTS" in similes
        assert "SIGNAL_CONTACTS" in similes

    def test_has_examples(self):
        assert len(list_contacts_action["examples"]) > 0


class TestListContactsValidate:
    @pytest.mark.asyncio
    async def test_accepts_signal_source(self):
        msg = MockMessage(source="signal")
        assert await list_contacts_validate(MockRuntime(), msg) is True

    @pytest.mark.asyncio
    async def test_rejects_non_signal_source(self):
        msg = MockMessage(source="matrix")
        assert await list_contacts_validate(MockRuntime(), msg) is False


class TestListContactsHandler:
    @pytest.mark.asyncio
    async def test_returns_failure_when_service_unavailable(self):
        service = MockSignalService(connected=False)
        runtime = MockRuntime(service=service)
        msg = MockMessage(source="signal")
        callback = _AsyncRecorder()

        result = await list_contacts_handler(runtime, msg, None, None, callback)

        assert result["success"] is False
        assert callback.called

    @pytest.mark.asyncio
    async def test_lists_unblocked_contacts_sorted_by_name(
        self, mock_signal_service,
    ):
        runtime = MockRuntime(service=mock_signal_service)
        msg = MockMessage(source="signal")
        callback = _AsyncRecorder()

        result = await list_contacts_handler(runtime, msg, None, None, callback)

        assert result["success"] is True
        # 4 total contacts, 1 blocked → 3 returned
        assert result["data"]["contact_count"] == 3

        names = [c["name"] for c in result["data"]["contacts"]]
        assert names == sorted(names, key=str.lower)

    @pytest.mark.asyncio
    async def test_excludes_blocked_contacts(self, mock_signal_service):
        runtime = MockRuntime(service=mock_signal_service)
        msg = MockMessage(source="signal")

        result = await list_contacts_handler(runtime, msg, None, None, None)

        contact_numbers = {c["number"] for c in result["data"]["contacts"]}
        assert "+14155550104" not in contact_numbers  # blocked user

    @pytest.mark.asyncio
    async def test_callback_text_contains_contact_count(self, mock_signal_service):
        runtime = MockRuntime(service=mock_signal_service)
        msg = MockMessage(source="signal")
        callback = _AsyncRecorder()

        await list_contacts_handler(runtime, msg, None, None, callback)

        assert callback.called
        assert "3" in callback.last_payload["text"]

    @pytest.mark.asyncio
    async def test_handles_empty_contact_list(self):
        service = MockSignalService(contacts=[])
        runtime = MockRuntime(service=service)
        msg = MockMessage(source="signal")

        result = await list_contacts_handler(runtime, msg, None, None, None)

        assert result["success"] is True
        assert result["data"]["contact_count"] == 0
        assert result["data"]["contacts"] == []


# =========================================================================
# list_groups_action
# =========================================================================


class TestListGroupsMetadata:
    def test_name(self):
        assert list_groups_action["name"] == "SIGNAL_LIST_GROUPS"

    def test_description_mentions_groups(self):
        assert "group" in list_groups_action["description"].lower()

    def test_similes(self):
        similes = list_groups_action["similes"]
        assert "LIST_SIGNAL_GROUPS" in similes
        assert "SHOW_GROUPS" in similes
        assert "GET_GROUPS" in similes
        assert "SIGNAL_GROUPS" in similes


class TestListGroupsValidate:
    @pytest.mark.asyncio
    async def test_accepts_signal_source(self):
        msg = MockMessage(source="signal")
        assert await list_groups_validate(MockRuntime(), msg) is True

    @pytest.mark.asyncio
    async def test_rejects_non_signal_source(self):
        msg = MockMessage(source="whatsapp")
        assert await list_groups_validate(MockRuntime(), msg) is False


class TestListGroupsHandler:
    @pytest.mark.asyncio
    async def test_returns_failure_when_service_unavailable(self):
        service = MockSignalService(connected=False)
        runtime = MockRuntime(service=service)
        msg = MockMessage(source="signal")
        callback = _AsyncRecorder()

        result = await list_groups_handler(runtime, msg, None, None, callback)

        assert result["success"] is False
        assert callback.called

    @pytest.mark.asyncio
    async def test_lists_active_member_groups_sorted(self, mock_signal_service):
        runtime = MockRuntime(service=mock_signal_service)
        msg = MockMessage(source="signal")
        callback = _AsyncRecorder()

        result = await list_groups_handler(runtime, msg, None, None, callback)

        assert result["success"] is True
        # 4 groups total: 2 active members, 1 not a member, 1 blocked
        assert result["data"]["group_count"] == 2

        names = [g["name"] for g in result["data"]["groups"]]
        assert names == sorted(names, key=str.lower)

    @pytest.mark.asyncio
    async def test_excludes_non_member_groups(self, mock_signal_service):
        runtime = MockRuntime(service=mock_signal_service)
        msg = MockMessage(source="signal")

        result = await list_groups_handler(runtime, msg, None, None, None)

        group_names = {g["name"] for g in result["data"]["groups"]}
        assert "Old Group" not in group_names

    @pytest.mark.asyncio
    async def test_excludes_blocked_groups(self, mock_signal_service):
        runtime = MockRuntime(service=mock_signal_service)
        msg = MockMessage(source="signal")

        result = await list_groups_handler(runtime, msg, None, None, None)

        group_names = {g["name"] for g in result["data"]["groups"]}
        assert "Spam Group" not in group_names

    @pytest.mark.asyncio
    async def test_includes_member_count(self, mock_signal_service):
        runtime = MockRuntime(service=mock_signal_service)
        msg = MockMessage(source="signal")

        result = await list_groups_handler(runtime, msg, None, None, None)

        family_group = next(
            g for g in result["data"]["groups"] if g["name"] == "Family Chat"
        )
        assert family_group["member_count"] == 3

    @pytest.mark.asyncio
    async def test_includes_description_in_output(self, mock_signal_service):
        runtime = MockRuntime(service=mock_signal_service)
        msg = MockMessage(source="signal")
        callback = _AsyncRecorder()

        await list_groups_handler(runtime, msg, None, None, callback)

        assert "family" in callback.last_payload["text"].lower()

    @pytest.mark.asyncio
    async def test_handles_empty_group_list(self):
        service = MockSignalService(groups=[])
        runtime = MockRuntime(service=service)
        msg = MockMessage(source="signal")

        result = await list_groups_handler(runtime, msg, None, None, None)

        assert result["success"] is True
        assert result["data"]["group_count"] == 0


# =========================================================================
# Helpers
# =========================================================================


class _AsyncRecorder:
    """Async-callable that records invocations."""

    def __init__(self):
        self.called = False
        self.call_count = 0
        self.last_payload: dict = {}

    async def __call__(self, payload: dict):
        self.called = True
        self.call_count += 1
        self.last_payload = payload
