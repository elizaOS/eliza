"""
Tests for all 3 Slack plugin providers:
  - channel_state (slackChannelState)
  - member_list  (slackMemberList)
  - workspace_info (slackWorkspaceInfo)

Each provider is tested for:
  - Metadata correctness (name, description, get function)
  - Returns empty when source is not slack
  - Returns structured data when source is slack
  - Edge cases (missing room, missing service, etc.)
"""

import pytest
from unittest.mock import AsyncMock, MagicMock

from elizaos_plugin_slack.providers.channel_state import channel_state_provider
from elizaos_plugin_slack.providers.member_list import member_list_provider
from elizaos_plugin_slack.providers.workspace_info import workspace_info_provider

from conftest import MockRoom, MockWorld, make_channel, make_user


ALL_PROVIDERS = [channel_state_provider, workspace_info_provider, member_list_provider]


# ===================================================================
# Metadata tests
# ===================================================================

class TestProviderMetadata:
    @pytest.mark.parametrize("provider", ALL_PROVIDERS, ids=[p["name"] for p in ALL_PROVIDERS])
    def test_has_required_keys(self, provider):
        assert "name" in provider
        assert "description" in provider
        assert "get" in provider

    @pytest.mark.parametrize("provider", ALL_PROVIDERS, ids=[p["name"] for p in ALL_PROVIDERS])
    def test_name_is_string(self, provider):
        assert isinstance(provider["name"], str)
        assert len(provider["name"]) > 0

    @pytest.mark.parametrize("provider", ALL_PROVIDERS, ids=[p["name"] for p in ALL_PROVIDERS])
    def test_description_is_string(self, provider):
        assert isinstance(provider["description"], str)
        assert len(provider["description"]) > 0

    @pytest.mark.parametrize("provider", ALL_PROVIDERS, ids=[p["name"] for p in ALL_PROVIDERS])
    def test_get_is_callable(self, provider):
        assert callable(provider["get"])

    def test_expected_names(self):
        names = {p["name"] for p in ALL_PROVIDERS}
        assert names == {"slackChannelState", "slackWorkspaceInfo", "slackMemberList"}

    def test_channel_state_metadata(self):
        assert channel_state_provider["name"] == "slackChannelState"
        assert "channel" in channel_state_provider["description"].lower()

    def test_member_list_metadata(self):
        assert member_list_provider["name"] == "slackMemberList"
        assert "member" in member_list_provider["description"].lower()

    def test_workspace_info_metadata(self):
        assert workspace_info_provider["name"] == "slackWorkspaceInfo"
        assert "workspace" in workspace_info_provider["description"].lower()


# ===================================================================
# channel_state provider
# ===================================================================

class TestChannelStateProvider:
    @pytest.mark.asyncio
    async def test_returns_empty_for_non_slack_source(self, mock_runtime, non_slack_message, mock_state):
        result = await channel_state_provider["get"](mock_runtime, non_slack_message, mock_state)
        assert result["data"] == {}
        assert result["text"] == ""

    @pytest.mark.asyncio
    async def test_returns_empty_when_no_room(self, mock_runtime, slack_message):
        state = MagicMock()
        state.data = {}
        state.agent_name = "Bot"
        state.sender_name = "User"
        mock_runtime.get_room = AsyncMock(return_value=None)
        result = await channel_state_provider["get"](mock_runtime, slack_message, state)
        assert result["data"] == {}

    @pytest.mark.asyncio
    async def test_returns_channel_data_for_public_channel(self, mock_runtime, slack_message, mock_state, mock_slack_service):
        result = await channel_state_provider["get"](mock_runtime, slack_message, mock_state)
        assert result["data"]["channel_type"] == "PUBLIC_CHANNEL"
        assert result["data"]["channel_name"] == "general"
        assert result["data"]["channel_id"] == "C0123456789"
        assert result["data"]["is_thread"] is False
        assert "text" in result
        assert len(result["text"]) > 0

    @pytest.mark.asyncio
    async def test_returns_dm_type_for_im_channel(self, mock_runtime, slack_message, mock_state, mock_slack_service):
        im_channel = make_channel(is_im=True, is_channel=False, name="")
        mock_slack_service.get_channel.return_value = im_channel
        result = await channel_state_provider["get"](mock_runtime, slack_message, mock_state)
        assert result["data"]["channel_type"] == "DM"

    @pytest.mark.asyncio
    async def test_returns_group_dm_type_for_mpim(self, mock_runtime, slack_message, mock_state, mock_slack_service):
        mpim_channel = make_channel(is_mpim=True, is_channel=False, name="group-chat")
        mock_slack_service.get_channel.return_value = mpim_channel
        result = await channel_state_provider["get"](mock_runtime, slack_message, mock_state)
        assert result["data"]["channel_type"] == "GROUP_DM"

    @pytest.mark.asyncio
    async def test_returns_private_channel_type(self, mock_runtime, slack_message, mock_state, mock_slack_service):
        priv_channel = make_channel(is_private=True, is_group=True, is_channel=False)
        mock_slack_service.get_channel.return_value = priv_channel
        result = await channel_state_provider["get"](mock_runtime, slack_message, mock_state)
        assert result["data"]["channel_type"] == "PRIVATE_CHANNEL"

    @pytest.mark.asyncio
    async def test_thread_context_included(self, mock_runtime, slack_message, mock_slack_service):
        room = MockRoom(metadata={"thread_ts": "1700000000.000050"})
        state = MagicMock()
        state.data = {"room": room}
        state.agent_name = "Bot"
        state.sender_name = "User"
        result = await channel_state_provider["get"](mock_runtime, slack_message, state)
        assert result["data"]["is_thread"] is True
        assert result["data"]["thread_ts"] == "1700000000.000050"
        assert "thread" in result["text"].lower()

    @pytest.mark.asyncio
    async def test_service_unavailable_returns_unknown(self, mock_runtime, slack_message, mock_state):
        mock_runtime.get_service.return_value = None
        result = await channel_state_provider["get"](mock_runtime, slack_message, mock_state)
        assert result["data"]["channel_type"] == "unknown"

    @pytest.mark.asyncio
    async def test_values_dict_present(self, mock_runtime, slack_message, mock_state):
        result = await channel_state_provider["get"](mock_runtime, slack_message, mock_state)
        assert "values" in result
        assert "channel_type" in result["values"]
        assert "channel_id" in result["values"]
        assert "is_thread" in result["values"]


# ===================================================================
# member_list provider
# ===================================================================

class TestMemberListProvider:
    @pytest.mark.asyncio
    async def test_returns_empty_for_non_slack_source(self, mock_runtime, non_slack_message, mock_state):
        result = await member_list_provider["get"](mock_runtime, non_slack_message, mock_state)
        assert result["data"] == {}
        assert result["text"] == ""

    @pytest.mark.asyncio
    async def test_returns_empty_when_no_room(self, mock_runtime, slack_message):
        state = MagicMock()
        state.data = {}
        mock_runtime.get_room = AsyncMock(return_value=None)
        result = await member_list_provider["get"](mock_runtime, slack_message, state)
        assert result["data"] == {}

    @pytest.mark.asyncio
    async def test_returns_empty_when_service_unavailable(self, mock_runtime, slack_message, mock_state):
        mock_runtime.get_service.return_value = None
        result = await member_list_provider["get"](mock_runtime, slack_message, mock_state)
        assert result["data"] == {}

    @pytest.mark.asyncio
    async def test_returns_member_data(self, mock_runtime, slack_message, mock_state, mock_slack_service):
        mock_slack_service.client.conversations_members = AsyncMock(
            return_value={"members": ["U0123456789", "U_BOT_001"]}
        )
        result = await member_list_provider["get"](mock_runtime, slack_message, mock_state)
        assert result["data"]["member_count"] == 2
        assert result["data"]["channel_name"] == "general"
        assert isinstance(result["data"]["members"], list)
        assert "text" in result
        assert len(result["text"]) > 0

    @pytest.mark.asyncio
    async def test_empty_member_list(self, mock_runtime, slack_message, mock_state, mock_slack_service):
        mock_slack_service.client.conversations_members = AsyncMock(
            return_value={"members": []}
        )
        result = await member_list_provider["get"](mock_runtime, slack_message, mock_state)
        assert result["data"]["member_count"] == 0

    @pytest.mark.asyncio
    async def test_values_dict_present(self, mock_runtime, slack_message, mock_state, mock_slack_service):
        mock_slack_service.client.conversations_members = AsyncMock(
            return_value={"members": ["U0123456789"]}
        )
        result = await member_list_provider["get"](mock_runtime, slack_message, mock_state)
        assert "values" in result
        assert "member_count" in result["values"]
        assert "channel_id" in result["values"]


# ===================================================================
# workspace_info provider
# ===================================================================

class TestWorkspaceInfoProvider:
    @pytest.mark.asyncio
    async def test_returns_empty_for_non_slack_source(self, mock_runtime, non_slack_message, mock_state):
        result = await workspace_info_provider["get"](mock_runtime, non_slack_message, mock_state)
        assert result["data"] == {}
        assert result["text"] == ""

    @pytest.mark.asyncio
    async def test_returns_empty_when_service_unavailable(self, mock_runtime, slack_message, mock_state):
        mock_runtime.get_service.return_value = None
        result = await workspace_info_provider["get"](mock_runtime, slack_message, mock_state)
        assert result["data"] == {}

    @pytest.mark.asyncio
    async def test_returns_workspace_data(self, mock_runtime, slack_message, mock_state, mock_slack_service):
        result = await workspace_info_provider["get"](mock_runtime, slack_message, mock_state)
        assert result["data"]["team_id"] == "T0123456789"
        assert result["data"]["bot_user_id"] == "U_BOT_001"
        assert result["data"]["is_connected"] is True
        assert "text" in result
        assert len(result["text"]) > 0

    @pytest.mark.asyncio
    async def test_channel_counts_computed(self, mock_runtime, slack_message, mock_state, mock_slack_service):
        channels = [
            make_channel(id="C001", name="general", is_private=False, is_archived=False, is_member=True),
            make_channel(id="C002", name="private", is_private=True, is_archived=False, is_member=True),
            make_channel(id="C003", name="archived", is_private=False, is_archived=True, is_member=False),
        ]
        mock_slack_service.list_channels.return_value = channels
        result = await workspace_info_provider["get"](mock_runtime, slack_message, mock_state)
        assert result["data"]["public_channel_count"] == 1
        assert result["data"]["private_channel_count"] == 1

    @pytest.mark.asyncio
    async def test_values_dict_present(self, mock_runtime, slack_message, mock_state):
        result = await workspace_info_provider["get"](mock_runtime, slack_message, mock_state)
        assert "values" in result
        assert "team_id" in result["values"]
        assert "bot_user_id" in result["values"]
        assert "is_connected" in result["values"]

    @pytest.mark.asyncio
    async def test_response_text_mentions_workspace(self, mock_runtime, slack_message, mock_state):
        result = await workspace_info_provider["get"](mock_runtime, slack_message, mock_state)
        assert "connected" in result["text"].lower() or "workspace" in result["text"].lower()
