"""
Tests for all 4 Twitch plugin actions:
- send_message
- join_channel
- leave_channel
- list_channels
"""

import pytest

from elizaos_plugin_twitch.actions.send_message import send_message_action, validate as sm_validate, handler as sm_handler
from elizaos_plugin_twitch.actions.join_channel import join_channel_action, validate as jc_validate, handler as jc_handler
from elizaos_plugin_twitch.actions.leave_channel import leave_channel_action, validate as lc_validate, handler as lc_handler
from elizaos_plugin_twitch.actions.list_channels import list_channels_action, validate as ls_validate, handler as ls_handler


# ===========================================================================
# send_message action
# ===========================================================================


class TestSendMessageMetadata:
    def test_name(self):
        assert send_message_action["name"] == "TWITCH_SEND_MESSAGE"

    def test_description(self):
        assert "Send" in send_message_action["description"]
        assert "Twitch" in send_message_action["description"]

    def test_similes(self):
        similes = send_message_action["similes"]
        assert "SEND_TWITCH_MESSAGE" in similes
        assert "TWITCH_CHAT" in similes
        assert "CHAT_TWITCH" in similes
        assert "SAY_IN_TWITCH" in similes
        assert len(similes) == 4

    def test_has_examples(self):
        assert len(send_message_action["examples"]) > 0

    def test_has_validate_and_handler(self):
        assert callable(send_message_action["validate"])
        assert callable(send_message_action["handler"])


class TestSendMessageValidate:
    @pytest.mark.asyncio
    async def test_accepts_twitch_source(self, mock_runtime, twitch_message):
        runtime = mock_runtime()
        msg = twitch_message(source="twitch")
        assert await sm_validate(runtime, msg) is True

    @pytest.mark.asyncio
    async def test_rejects_discord_source(self, mock_runtime, twitch_message):
        runtime = mock_runtime()
        msg = twitch_message(source="discord")
        assert await sm_validate(runtime, msg) is False

    @pytest.mark.asyncio
    async def test_rejects_empty_source(self, mock_runtime, twitch_message):
        runtime = mock_runtime()
        msg = twitch_message(source="")
        assert await sm_validate(runtime, msg) is False


class TestSendMessageHandler:
    @pytest.mark.asyncio
    async def test_returns_error_when_service_unavailable(self, mock_runtime, twitch_message):
        runtime = mock_runtime(service=None)
        msg = twitch_message()
        callback_payloads = []

        async def callback(resp):
            callback_payloads.append(resp)

        result = await sm_handler(runtime, msg, {}, {}, callback)

        assert result["success"] is False
        assert result["error"] == "Twitch service not available"
        assert len(callback_payloads) == 1
        assert callback_payloads[0]["text"] == "Twitch service is not available."

    @pytest.mark.asyncio
    async def test_returns_error_when_service_disconnected(self, mock_runtime, mock_service, twitch_message):
        service = mock_service(connected=False)
        runtime = mock_runtime(service=service)
        msg = twitch_message()
        callback_payloads = []

        async def callback(resp):
            callback_payloads.append(resp)

        result = await sm_handler(runtime, msg, {}, {}, callback)

        assert result["success"] is False
        assert "not available" in result["error"]


# ===========================================================================
# join_channel action
# ===========================================================================


class TestJoinChannelMetadata:
    def test_name(self):
        assert join_channel_action["name"] == "TWITCH_JOIN_CHANNEL"

    def test_description(self):
        assert "Join" in join_channel_action["description"]
        assert "Twitch" in join_channel_action["description"]

    def test_similes(self):
        similes = join_channel_action["similes"]
        assert "JOIN_TWITCH_CHANNEL" in similes
        assert "ENTER_CHANNEL" in similes
        assert "CONNECT_CHANNEL" in similes
        assert len(similes) == 3

    def test_has_examples(self):
        assert len(join_channel_action["examples"]) > 0


class TestJoinChannelValidate:
    @pytest.mark.asyncio
    async def test_accepts_twitch_source(self, mock_runtime, twitch_message):
        runtime = mock_runtime()
        msg = twitch_message(source="twitch")
        assert await jc_validate(runtime, msg) is True

    @pytest.mark.asyncio
    async def test_rejects_discord_source(self, mock_runtime, twitch_message):
        runtime = mock_runtime()
        msg = twitch_message(source="discord")
        assert await jc_validate(runtime, msg) is False

    @pytest.mark.asyncio
    async def test_rejects_telegram_source(self, mock_runtime, twitch_message):
        runtime = mock_runtime()
        msg = twitch_message(source="telegram")
        assert await jc_validate(runtime, msg) is False


class TestJoinChannelHandler:
    @pytest.mark.asyncio
    async def test_returns_error_when_service_unavailable(self, mock_runtime, twitch_message):
        runtime = mock_runtime(service=None)
        msg = twitch_message()
        callback_payloads = []

        async def callback(resp):
            callback_payloads.append(resp)

        result = await jc_handler(runtime, msg, {}, {}, callback)

        assert result["success"] is False
        assert result["error"] == "Twitch service not available"
        assert callback_payloads[0]["text"] == "Twitch service is not available."

    @pytest.mark.asyncio
    async def test_returns_error_when_disconnected(self, mock_runtime, mock_service, twitch_message):
        service = mock_service(connected=False)
        runtime = mock_runtime(service=service)
        msg = twitch_message()

        result = await jc_handler(runtime, msg, {})

        assert result["success"] is False


# ===========================================================================
# leave_channel action
# ===========================================================================


class TestLeaveChannelMetadata:
    def test_name(self):
        assert leave_channel_action["name"] == "TWITCH_LEAVE_CHANNEL"

    def test_description(self):
        assert "Leave" in leave_channel_action["description"]
        assert "Twitch" in leave_channel_action["description"]

    def test_similes(self):
        similes = leave_channel_action["similes"]
        assert "LEAVE_TWITCH_CHANNEL" in similes
        assert "EXIT_CHANNEL" in similes
        assert "PART_CHANNEL" in similes
        assert "DISCONNECT_CHANNEL" in similes
        assert len(similes) == 4

    def test_has_examples(self):
        assert len(leave_channel_action["examples"]) > 0


class TestLeaveChannelValidate:
    @pytest.mark.asyncio
    async def test_accepts_twitch_source(self, mock_runtime, twitch_message):
        runtime = mock_runtime()
        msg = twitch_message(source="twitch")
        assert await lc_validate(runtime, msg) is True

    @pytest.mark.asyncio
    async def test_rejects_discord_source(self, mock_runtime, twitch_message):
        runtime = mock_runtime()
        msg = twitch_message(source="discord")
        assert await lc_validate(runtime, msg) is False


class TestLeaveChannelHandler:
    @pytest.mark.asyncio
    async def test_returns_error_when_service_unavailable(self, mock_runtime, twitch_message):
        runtime = mock_runtime(service=None)
        msg = twitch_message()
        callback_payloads = []

        async def callback(resp):
            callback_payloads.append(resp)

        result = await lc_handler(runtime, msg, {}, {}, callback)

        assert result["success"] is False
        assert result["error"] == "Twitch service not available"
        assert callback_payloads[0]["text"] == "Twitch service is not available."

    @pytest.mark.asyncio
    async def test_returns_error_when_disconnected(self, mock_runtime, mock_service, twitch_message):
        service = mock_service(connected=False)
        runtime = mock_runtime(service=service)
        msg = twitch_message()

        result = await lc_handler(runtime, msg, {})

        assert result["success"] is False


# ===========================================================================
# list_channels action
# ===========================================================================


class TestListChannelsMetadata:
    def test_name(self):
        assert list_channels_action["name"] == "TWITCH_LIST_CHANNELS"

    def test_description(self):
        assert "List" in list_channels_action["description"]
        assert "Twitch" in list_channels_action["description"]

    def test_similes(self):
        similes = list_channels_action["similes"]
        assert "LIST_TWITCH_CHANNELS" in similes
        assert "SHOW_CHANNELS" in similes
        assert "GET_CHANNELS" in similes
        assert "CURRENT_CHANNELS" in similes
        assert len(similes) == 4

    def test_has_examples(self):
        assert len(list_channels_action["examples"]) > 0


class TestListChannelsValidate:
    @pytest.mark.asyncio
    async def test_accepts_twitch_source(self, mock_runtime, twitch_message):
        runtime = mock_runtime()
        msg = twitch_message(source="twitch")
        assert await ls_validate(runtime, msg) is True

    @pytest.mark.asyncio
    async def test_rejects_slack_source(self, mock_runtime, twitch_message):
        runtime = mock_runtime()
        msg = twitch_message(source="slack")
        assert await ls_validate(runtime, msg) is False


class TestListChannelsHandler:
    @pytest.mark.asyncio
    async def test_returns_error_when_service_unavailable(self, mock_runtime, twitch_message):
        runtime = mock_runtime(service=None)
        msg = twitch_message()
        callback_payloads = []

        async def callback(resp):
            callback_payloads.append(resp)

        result = await ls_handler(runtime, msg, {}, {}, callback)

        assert result["success"] is False
        assert result["error"] == "Twitch service not available"
        assert callback_payloads[0]["text"] == "Twitch service is not available."

    @pytest.mark.asyncio
    async def test_returns_channel_list_when_connected(self, mock_runtime, mock_service, twitch_message):
        service = mock_service(
            connected=True,
            primary_channel="mainchannel",
            joined_channels=["mainchannel", "otherchannel"],
        )
        runtime = mock_runtime(service=service)
        msg = twitch_message()
        callback_payloads = []

        async def callback(resp):
            callback_payloads.append(resp)

        result = await ls_handler(runtime, msg, {}, {}, callback)

        assert result["success"] is True
        assert result["data"]["channel_count"] == 2
        assert result["data"]["channels"] == ["mainchannel", "otherchannel"]
        assert result["data"]["primary_channel"] == "mainchannel"
        assert "2 channel(s)" in callback_payloads[0]["text"]
        assert "#mainchannel (primary)" in callback_payloads[0]["text"]
        assert "#otherchannel" in callback_payloads[0]["text"]

    @pytest.mark.asyncio
    async def test_returns_empty_message_for_no_channels(self, mock_runtime, mock_service, twitch_message):
        service = mock_service(
            connected=True,
            primary_channel="main",
            joined_channels=[],
        )
        runtime = mock_runtime(service=service)
        msg = twitch_message()
        callback_payloads = []

        async def callback(resp):
            callback_payloads.append(resp)

        result = await ls_handler(runtime, msg, {}, {}, callback)

        assert result["success"] is True
        assert result["data"]["channel_count"] == 0
        assert callback_payloads[0]["text"] == "Not currently in any channels."
