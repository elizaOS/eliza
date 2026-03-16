"""Tests for providers."""

import pytest

from elizaos_plugin_discord.providers import (
    ProviderContext,
    get_all_providers,
)
from elizaos_plugin_discord.providers.channel_state import ChannelStateProvider
from elizaos_plugin_discord.providers.guild_info import GuildInfoProvider
from elizaos_plugin_discord.providers.voice_state import VoiceStateProvider


class TestChannelStateProvider:
    """Tests for ChannelStateProvider."""

    @pytest.mark.asyncio
    async def test_channel_state_dm(self) -> None:
        """Test channel state for DM."""
        provider = ChannelStateProvider()
        context = ProviderContext(
            channel_id="123456789012345678",
            guild_id=None,
            user_id="987654321098765432",
            room_id="room-uuid",
        )

        state = await provider.get(context)

        assert state["is_dm"] is True
        assert state["channel_type"] == "dm"
        assert state["channel_id"] == "123456789012345678"

    @pytest.mark.asyncio
    async def test_channel_state_guild(self) -> None:
        """Test channel state for guild."""
        provider = ChannelStateProvider()
        context = ProviderContext(
            channel_id="123456789012345678",
            guild_id="111222333444555666",
            user_id="987654321098765432",
            room_id="room-uuid",
        )

        state = await provider.get(context)

        assert state["is_dm"] is False
        assert state["channel_type"] == "guild_text"


class TestVoiceStateProvider:
    """Tests for VoiceStateProvider."""

    @pytest.mark.asyncio
    async def test_voice_state(self) -> None:
        """Test voice state."""
        provider = VoiceStateProvider()
        context = ProviderContext(
            channel_id="123456789012345678",
            guild_id="111222333444555666",
            user_id="987654321098765432",
        )

        state = await provider.get(context)

        assert state["voice_channel"]["connected"] is False
        assert state["members_in_voice"] == []


class TestGuildInfoProvider:
    """Tests for GuildInfoProvider."""

    @pytest.mark.asyncio
    async def test_guild_info_with_guild(self) -> None:
        """Test guild info when in guild."""
        provider = GuildInfoProvider()
        context = ProviderContext(
            channel_id="123456789012345678",
            guild_id="111222333444555666",
            user_id="987654321098765432",
        )

        state = await provider.get(context)

        assert state["is_in_guild"] is True
        assert state["guild_id"] == "111222333444555666"

    @pytest.mark.asyncio
    async def test_guild_info_without_guild(self) -> None:
        """Test guild info when not in guild (DM)."""
        provider = GuildInfoProvider()
        context = ProviderContext(
            channel_id="123456789012345678",
            guild_id=None,
            user_id="987654321098765432",
        )

        state = await provider.get(context)

        assert state["is_in_guild"] is False
        assert state["guild"] is None


class TestGetAllProviders:
    """Tests for get_all_providers."""

    def test_get_all_providers(self) -> None:
        """Test that all providers are returned."""
        providers = get_all_providers()
        assert len(providers) == 3

        names = [p.name for p in providers]
        assert "channel_state" in names
        assert "voice_state" in names
        assert "guild_info" in names
