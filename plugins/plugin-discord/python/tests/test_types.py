"""Tests for type definitions."""

import pytest

from elizaos_plugin_discord.error import InvalidSnowflakeError
from elizaos_plugin_discord.types import (
    DiscordChannelType,
    DiscordEventType,
    DiscordMessagePayload,
    Snowflake,
)


class TestSnowflake:
    """Tests for Snowflake validation."""

    def test_valid_snowflakes(self) -> None:
        """Test valid snowflake IDs."""
        assert Snowflake("12345678901234567") == "12345678901234567"
        assert Snowflake("123456789012345678") == "123456789012345678"
        assert Snowflake("1234567890123456789") == "1234567890123456789"

    def test_invalid_snowflake_too_short(self) -> None:
        """Test snowflake that is too short."""
        with pytest.raises(InvalidSnowflakeError):
            Snowflake("1234567890123456")

    def test_invalid_snowflake_too_long(self) -> None:
        """Test snowflake that is too long."""
        with pytest.raises(InvalidSnowflakeError):
            Snowflake("12345678901234567890")

    def test_invalid_snowflake_contains_letters(self) -> None:
        """Test snowflake that contains letters."""
        with pytest.raises(InvalidSnowflakeError):
            Snowflake("1234567890123456a")

    def test_invalid_snowflake_empty(self) -> None:
        """Test empty snowflake."""
        with pytest.raises(InvalidSnowflakeError):
            Snowflake("")

    def test_snowflake_as_int(self) -> None:
        """Test converting snowflake to int."""
        s = Snowflake("123456789012345678")
        assert s.as_int() == 123456789012345678


class TestEventTypes:
    """Tests for event type enums."""

    def test_event_type_values(self) -> None:
        """Test event type values."""
        assert DiscordEventType.MESSAGE_RECEIVED.value == "MESSAGE_RECEIVED"
        assert DiscordEventType.WORLD_CONNECTED.value == "WORLD_CONNECTED"

    def test_channel_type_values(self) -> None:
        """Test channel type values."""
        assert DiscordChannelType.TEXT.value == "TEXT"
        assert DiscordChannelType.DM.value == "DM"
        assert DiscordChannelType.VOICE.value == "VOICE"


class TestMessagePayload:
    """Tests for message payload."""

    def test_valid_payload(self) -> None:
        """Test creating a valid message payload."""
        payload = DiscordMessagePayload(
            message_id="123456789012345678",
            channel_id="987654321098765432",
            guild_id="111222333444555666",
            author_id="999888777666555444",
            author_name="TestUser",
            content="Hello, world!",
            timestamp="2024-01-01T00:00:00Z",
            is_bot=False,
        )
        assert payload.content == "Hello, world!"
        assert payload.author_name == "TestUser"

    def test_payload_with_none_guild(self) -> None:
        """Test creating a payload for DM (no guild)."""
        payload = DiscordMessagePayload(
            message_id="123456789012345678",
            channel_id="987654321098765432",
            guild_id=None,
            author_id="999888777666555444",
            author_name="TestUser",
            content="DM content",
            timestamp="2024-01-01T00:00:00Z",
            is_bot=False,
        )
        assert payload.guild_id is None

    def test_payload_invalid_snowflake(self) -> None:
        """Test that invalid snowflakes are rejected."""
        with pytest.raises(InvalidSnowflakeError):
            DiscordMessagePayload(
                message_id="invalid",
                channel_id="987654321098765432",
                author_id="999888777666555444",
                author_name="TestUser",
                content="Hello",
                timestamp="2024-01-01T00:00:00Z",
                is_bot=False,
            )
