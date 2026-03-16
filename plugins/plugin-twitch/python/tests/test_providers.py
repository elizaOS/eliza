"""
Tests for Twitch plugin providers:
- channel_state
- user_context
"""

import pytest

from elizaos_plugin_twitch.providers.channel_state import (
    channel_state_provider,
    get_channel_state,
)
from elizaos_plugin_twitch.providers.user_context import (
    user_context_provider,
    get_user_context,
)
from elizaos_plugin_twitch.types import TwitchUserInfo


# ===========================================================================
# channelStateProvider metadata
# ===========================================================================


class TestChannelStateProviderMetadata:
    def test_name(self):
        assert channel_state_provider["name"] == "twitchChannelState"

    def test_description(self):
        assert "Twitch channel" in channel_state_provider["description"]

    def test_has_get_callable(self):
        assert callable(channel_state_provider["get"])


# ===========================================================================
# channelStateProvider get()
# ===========================================================================


class TestChannelStateGet:
    @pytest.mark.asyncio
    async def test_returns_empty_for_non_twitch_source(self, mock_runtime, twitch_message):
        runtime = mock_runtime()
        msg = twitch_message(source="discord")
        result = await get_channel_state(runtime, msg, {})
        assert result["text"] == ""
        assert result["data"] == {}

    @pytest.mark.asyncio
    async def test_returns_disconnected_when_no_service(self, mock_runtime, twitch_message):
        runtime = mock_runtime(service=None)
        msg = twitch_message(source="twitch")
        result = await get_channel_state(runtime, msg, {})
        assert result["data"]["connected"] is False
        assert result["text"] == ""

    @pytest.mark.asyncio
    async def test_returns_disconnected_when_service_offline(self, mock_runtime, mock_service, twitch_message):
        service = mock_service(connected=False)
        runtime = mock_runtime(service=service)
        msg = twitch_message(source="twitch")
        result = await get_channel_state(runtime, msg, {})
        assert result["data"]["connected"] is False

    @pytest.mark.asyncio
    async def test_returns_full_state_when_connected(self, mock_runtime, mock_service, twitch_message):
        service = mock_service(
            connected=True,
            bot_username="testbot",
            primary_channel="mainchannel",
            joined_channels=["mainchannel", "extra"],
        )
        runtime = mock_runtime(service=service)
        msg = twitch_message(source="twitch")
        state = {"agentName": "CoolBot"}

        result = await get_channel_state(runtime, msg, state)

        assert result["data"]["connected"] is True
        assert result["data"]["channel"] == "mainchannel"
        assert result["data"]["display_channel"] == "#mainchannel"
        assert result["data"]["is_primary_channel"] is True
        assert result["data"]["bot_username"] == "testbot"
        assert result["data"]["channel_count"] == 2
        assert result["data"]["joined_channels"] == ["mainchannel", "extra"]
        assert "CoolBot" in result["text"]
        assert "#mainchannel" in result["text"]
        assert "primary channel" in result["text"]
        assert "@testbot" in result["text"]
        assert "2 channel(s)" in result["text"]

    @pytest.mark.asyncio
    async def test_uses_room_channel_id_from_state(self, mock_runtime, mock_service, twitch_message):
        service = mock_service(
            connected=True,
            primary_channel="mainchannel",
            joined_channels=["mainchannel", "otherchan"],
        )
        runtime = mock_runtime(service=service)
        msg = twitch_message(source="twitch")
        state = {"data": {"room": {"channel_id": "#otherchan"}}}

        result = await get_channel_state(runtime, msg, state)

        assert result["data"]["channel"] == "otherchan"
        assert result["data"]["is_primary_channel"] is False

    @pytest.mark.asyncio
    async def test_defaults_agent_name(self, mock_runtime, mock_service, twitch_message):
        service = mock_service(connected=True)
        runtime = mock_runtime(service=service)
        msg = twitch_message(source="twitch")

        result = await get_channel_state(runtime, msg, {})

        assert "The agent" in result["text"]


# ===========================================================================
# userContextProvider metadata
# ===========================================================================


class TestUserContextProviderMetadata:
    def test_name(self):
        assert user_context_provider["name"] == "twitchUserContext"

    def test_description(self):
        assert "Twitch user" in user_context_provider["description"]

    def test_has_get_callable(self):
        assert callable(user_context_provider["get"])


# ===========================================================================
# userContextProvider get()
# ===========================================================================


class TestUserContextGet:
    @pytest.mark.asyncio
    async def test_returns_empty_for_non_twitch_source(self, mock_runtime, twitch_message):
        runtime = mock_runtime()
        msg = twitch_message(source="discord")
        result = await get_user_context(runtime, msg, {})
        assert result["text"] == ""
        assert result["data"] == {}

    @pytest.mark.asyncio
    async def test_returns_empty_when_no_service(self, mock_runtime, twitch_message):
        runtime = mock_runtime(service=None)
        msg = twitch_message(source="twitch")
        result = await get_user_context(runtime, msg, {})
        assert result["text"] == ""
        assert result["data"] == {}

    @pytest.mark.asyncio
    async def test_returns_empty_when_no_user_metadata(self, mock_runtime, mock_service, twitch_message):
        service = mock_service(connected=True)
        runtime = mock_runtime(service=service)
        msg = twitch_message(source="twitch")
        result = await get_user_context(runtime, msg, {})
        assert result["text"] == ""
        assert result["data"] == {}

    @pytest.mark.asyncio
    async def test_returns_broadcaster_context(self, mock_runtime, mock_service, twitch_message, broadcaster_user_info):
        service = mock_service(connected=True)
        runtime = mock_runtime(service=service)
        msg = twitch_message(
            source="twitch",
            metadata={"user": broadcaster_user_info},
        )
        state = {"agentName": "MyBot"}

        result = await get_user_context(runtime, msg, state)

        assert result["data"]["user_id"] == "99"
        assert result["data"]["username"] == "streamer"
        assert result["data"]["display_name"] == "Streamer"
        assert result["data"]["is_broadcaster"] is True
        assert result["data"]["is_subscriber"] is True
        assert "broadcaster" in result["data"]["roles"]
        assert "subscriber" in result["data"]["roles"]
        assert "broadcaster" in result["values"]["role_text"]
        assert "MyBot" in result["text"]
        assert "Streamer" in result["text"]
        assert "channel owner/broadcaster" in result["text"]

    @pytest.mark.asyncio
    async def test_returns_viewer_role_for_no_roles(self, mock_runtime, mock_service, twitch_message, sample_user_info):
        service = mock_service(connected=True)
        runtime = mock_runtime(service=service)
        msg = twitch_message(
            source="twitch",
            metadata={"user": sample_user_info},
        )

        result = await get_user_context(runtime, msg, {})

        assert result["values"]["role_text"] == "viewer"
        assert result["data"]["roles"] == []

    @pytest.mark.asyncio
    async def test_moderator_context_text(self, mock_runtime, mock_service, twitch_message, moderator_user_info):
        service = mock_service(connected=True)
        runtime = mock_runtime(service=service)
        msg = twitch_message(
            source="twitch",
            metadata={"user": moderator_user_info},
        )

        result = await get_user_context(runtime, msg, {})

        assert result["data"]["is_moderator"] is True
        assert "channel moderator" in result["text"]
        assert "broadcaster" not in result["text"]
