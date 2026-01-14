"""
Integration tests for elizaOS Plugin Discord (Python)

These tests verify Discord operations work correctly with a real Discord server.

Running Tests:
    Set the following environment variables:
    - DISCORD_API_TOKEN: Bot token
    - DISCORD_APPLICATION_ID: Application ID
    - DISCORD_TEST_CHANNEL_ID: Channel ID for testing

    Then run:
    pytest tests/test_integration.py -v --run-integration
"""

import os

import pytest

from elizaos_plugin_discord import DiscordConfig, DiscordService
from elizaos_plugin_discord.types import Snowflake

# Mark all tests in this module as integration tests
pytestmark = pytest.mark.integration


def integration_configured() -> bool:
    """Check if integration test environment is configured."""
    return bool(os.environ.get("DISCORD_API_TOKEN") and os.environ.get("DISCORD_APPLICATION_ID"))


@pytest.fixture
def discord_config() -> DiscordConfig:
    """Get Discord configuration from environment."""
    if not integration_configured():
        pytest.skip("Integration test environment not configured")
    return DiscordConfig.from_env()


@pytest.fixture
async def discord_service(discord_config: DiscordConfig) -> DiscordService:
    """Create a Discord service (not started)."""
    return DiscordService(discord_config)


class TestConnection:
    """Integration tests for Discord connection."""

    @pytest.mark.asyncio
    @pytest.mark.skipif(not integration_configured(), reason="Requires Discord credentials")
    async def test_service_creation_from_env(self) -> None:
        """Test creating service from environment."""
        config = DiscordConfig.from_env()
        service = DiscordService(config)

        assert service.config.token
        assert service.config.application_id
        assert not service.is_running


class TestSnowflakeValidation:
    """Tests for snowflake validation in integration context."""

    def test_real_snowflake_format(self) -> None:
        """Test that real Discord snowflakes validate correctly."""
        # These are example Discord IDs in the correct format
        valid_ids = [
            "123456789012345678",
            "987654321098765432",
            "1234567890123456789",
        ]

        for id_str in valid_ids:
            snowflake = Snowflake(id_str)
            assert snowflake.as_int() == int(id_str)


class TestMessageOperations:
    """Integration tests for message operations."""

    @pytest.mark.asyncio
    @pytest.mark.skipif(not integration_configured(), reason="Requires Discord credentials")
    async def test_send_message_validation(
        self,
        discord_service: DiscordService,  # noqa: ARG002
    ) -> None:
        """Test message sending validation (without actually sending)."""
        # This test validates the request would be valid
        # without actually connecting to Discord

        test_channel = os.environ.get("DISCORD_TEST_CHANNEL_ID")
        if not test_channel:
            pytest.skip("DISCORD_TEST_CHANNEL_ID not set")

        # Validate snowflake format
        snowflake = Snowflake(test_channel)
        assert snowflake.as_int() > 0


class TestEventHandling:
    """Integration tests for event handling."""

    @pytest.mark.asyncio
    async def test_event_callback_registration(self, discord_service: DiscordService) -> None:
        """Test registering event callbacks."""
        events_received: list[tuple] = []

        @discord_service.on_event
        async def handler(event_type, payload):
            events_received.append((event_type, payload))

        assert len(discord_service._event_callbacks) == 1

    @pytest.mark.asyncio
    async def test_message_callback_registration(self, discord_service: DiscordService) -> None:
        """Test registering message callbacks."""
        messages_received: list = []

        @discord_service.on_message
        async def handler(message):
            messages_received.append(message)

        assert len(discord_service._message_callbacks) == 1
