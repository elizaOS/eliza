"""
Tests for the Signal conversation state provider.

Covers:
- Provider metadata (name, description)
- DM conversation context generation
- Group conversation context generation
- Fallback when room is None
- Fallback when source is not signal
- Fallback when service is disconnected
"""

import pytest

from elizaos_plugin_signal.providers.conversation_state import (
    conversation_state_provider,
    get_conversation_state,
)

from tests.conftest import (
    MockMessage,
    MockRuntime,
    MockSignalService,
    SAMPLE_CONTACTS,
    SAMPLE_GROUPS,
)


# =========================================================================
# Provider metadata
# =========================================================================


class TestProviderMetadata:
    def test_name(self):
        assert conversation_state_provider["name"] == "signalConversationState"

    def test_description_is_meaningful(self):
        desc = conversation_state_provider["description"]
        assert "conversation" in desc.lower()
        assert len(desc) > 20

    def test_get_is_callable(self):
        assert callable(conversation_state_provider["get"])


# =========================================================================
# DM conversation state
# =========================================================================


class TestDMConversationState:
    @pytest.mark.asyncio
    async def test_returns_dm_type(self, dm_runtime):
        msg = MockMessage(source="signal")
        state = {"agentName": "Agent", "senderName": "Alice"}

        result = await get_conversation_state(dm_runtime, msg, state)

        assert result["data"]["conversation_type"] == "DM"
        assert result["values"]["conversation_type"] == "DM"
        assert result["data"]["is_group"] is False

    @pytest.mark.asyncio
    async def test_resolves_contact_name_from_cache(self, dm_runtime):
        msg = MockMessage(source="signal")
        state = {"agentName": "Agent", "senderName": "Unknown"}

        result = await get_conversation_state(dm_runtime, msg, state)

        assert result["data"]["contact_name"] == "Alice Johnson"
        assert result["values"]["contact_name"] == "Alice Johnson"

    @pytest.mark.asyncio
    async def test_text_mentions_agent_and_contact(self, dm_runtime):
        msg = MockMessage(source="signal")
        state = {"agentName": "Eliza", "senderName": "Sender"}

        result = await get_conversation_state(dm_runtime, msg, state)

        text = result["text"]
        assert "Eliza" in text
        assert "Alice Johnson" in text
        assert "direct message" in text.lower()

    @pytest.mark.asyncio
    async def test_text_mentions_encryption(self, dm_runtime):
        msg = MockMessage(source="signal")
        state = {"agentName": "Agent", "senderName": "Sender"}

        result = await get_conversation_state(dm_runtime, msg, state)

        assert "encrypted" in result["text"].lower()

    @pytest.mark.asyncio
    async def test_channel_id_is_set(self, dm_runtime):
        msg = MockMessage(source="signal")
        state = {"agentName": "Agent", "senderName": "Sender"}

        result = await get_conversation_state(dm_runtime, msg, state)

        assert result["data"]["channel_id"] == "+14155550101"
        assert result["values"]["channel_id"] == "+14155550101"

    @pytest.mark.asyncio
    async def test_includes_account_number(self, dm_runtime):
        msg = MockMessage(source="signal")
        state = {"agentName": "Agent", "senderName": "Sender"}

        result = await get_conversation_state(dm_runtime, msg, state)

        assert result["data"]["account_number"] == "+14155550100"

    @pytest.mark.asyncio
    async def test_falls_back_to_sender_name_when_contact_unknown(self):
        service = MockSignalService(contacts=[])  # empty cache
        room = {
            "channel_id": "+19999999999",
            "name": "Unknown DM",
            "metadata": {"is_group": False},
        }
        runtime = MockRuntime(service=service, room=room)
        msg = MockMessage(source="signal")
        state = {"agentName": "Agent", "senderName": "Mystery Caller"}

        result = await get_conversation_state(runtime, msg, state)

        assert result["data"]["contact_name"] == "Mystery Caller"


# =========================================================================
# Group conversation state
# =========================================================================


class TestGroupConversationState:
    @pytest.mark.asyncio
    async def test_returns_group_type(self, group_runtime):
        msg = MockMessage(source="signal")
        state = {"agentName": "Agent", "senderName": "Sender"}

        result = await get_conversation_state(group_runtime, msg, state)

        assert result["data"]["conversation_type"] == "GROUP"
        assert result["values"]["conversation_type"] == "GROUP"
        assert result["data"]["is_group"] is True

    @pytest.mark.asyncio
    async def test_resolves_group_name_from_cache(self, group_runtime):
        msg = MockMessage(source="signal")
        state = {"agentName": "Agent", "senderName": "Sender"}

        result = await get_conversation_state(group_runtime, msg, state)

        assert result["data"]["group_name"] == "Family Chat"
        assert result["values"]["group_name"] == "Family Chat"

    @pytest.mark.asyncio
    async def test_text_mentions_group_name(self, group_runtime):
        msg = MockMessage(source="signal")
        state = {"agentName": "Eliza", "senderName": "Sender"}

        result = await get_conversation_state(group_runtime, msg, state)

        assert "Family Chat" in result["text"]
        assert "group chat" in result["text"].lower()

    @pytest.mark.asyncio
    async def test_text_includes_multi_participant_warning(self, group_runtime):
        msg = MockMessage(source="signal")
        state = {"agentName": "Agent", "senderName": "Sender"}

        result = await get_conversation_state(group_runtime, msg, state)

        assert "multiple people" in result["text"].lower()

    @pytest.mark.asyncio
    async def test_text_includes_group_description(self, group_runtime):
        msg = MockMessage(source="signal")
        state = {"agentName": "Agent", "senderName": "Sender"}

        result = await get_conversation_state(group_runtime, msg, state)

        assert "family members" in result["text"].lower()

    @pytest.mark.asyncio
    async def test_falls_back_to_room_name_when_group_not_cached(self):
        service = MockSignalService(groups=[])  # empty cache
        room = {
            "channel_id": "unknown_group_id_base64padding==",
            "name": "Fallback Name",
            "metadata": {
                "is_group": True,
                "group_id": "unknown_group_id_base64padding==",
            },
        }
        runtime = MockRuntime(service=service, room=room)
        msg = MockMessage(source="signal")
        state = {"agentName": "Agent", "senderName": "Sender"}

        result = await get_conversation_state(runtime, msg, state)

        assert result["data"]["group_name"] == "Fallback Name"


# =========================================================================
# Edge cases / fallbacks
# =========================================================================


class TestConversationStateEdgeCases:
    @pytest.mark.asyncio
    async def test_returns_empty_when_room_is_none(self):
        service = MockSignalService()
        runtime = MockRuntime(service=service, room=None)
        msg = MockMessage(source="signal")

        result = await get_conversation_state(runtime, msg, {"agentName": "A"})

        assert result["data"] == {}
        assert result["text"] == ""

    @pytest.mark.asyncio
    async def test_returns_empty_for_non_signal_source(self):
        service = MockSignalService()
        room = {"channel_id": "+1", "name": "DM", "metadata": {"is_group": False}}
        runtime = MockRuntime(service=service, room=room)
        msg = MockMessage(source="discord")

        result = await get_conversation_state(runtime, msg, {"agentName": "A"})

        assert result["data"] == {}
        assert result["text"] == ""

    @pytest.mark.asyncio
    async def test_returns_unknown_type_when_service_disconnected(self):
        service = MockSignalService(connected=False)
        room = {
            "channel_id": "+14155550101",
            "name": "DM",
            "metadata": {"is_group": False},
        }
        runtime = MockRuntime(service=service, room=room)
        msg = MockMessage(source="signal")

        result = await get_conversation_state(runtime, msg, {"agentName": "A"})

        assert result["data"]["conversation_type"] == "unknown"
        assert result["text"] == ""

    @pytest.mark.asyncio
    async def test_handles_none_state(self):
        service = MockSignalService()
        runtime = MockRuntime(service=service, room=None)
        msg = MockMessage(source="signal")

        # Should not raise
        result = await get_conversation_state(runtime, msg, None)

        assert result["text"] == ""

    @pytest.mark.asyncio
    async def test_handles_empty_state_dict(self):
        service = MockSignalService()
        room = {
            "channel_id": "+14155550101",
            "name": "DM",
            "metadata": {"is_group": False},
        }
        runtime = MockRuntime(service=service, room=room)
        msg = MockMessage(source="signal")

        result = await get_conversation_state(runtime, msg, {})

        # Should use defaults for agentName/senderName
        assert "The agent" in result["text"]
