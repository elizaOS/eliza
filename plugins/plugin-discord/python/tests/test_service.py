"""Tests for service."""

from elizaos_plugin_discord.config import DiscordConfig
from elizaos_plugin_discord.service import MAX_MESSAGE_LENGTH, DiscordService, split_message


class TestSplitMessage:
    """Tests for message splitting."""

    def test_short_message_no_split(self) -> None:
        """Test that short messages are not split."""
        msg = "Hello, world!"
        parts = split_message(msg)
        assert len(parts) == 1
        assert parts[0] == msg

    def test_long_message_split(self) -> None:
        """Test that long messages are split."""
        msg = "a" * (MAX_MESSAGE_LENGTH + 500)
        parts = split_message(msg)
        assert len(parts) > 1
        for part in parts:
            assert len(part) <= MAX_MESSAGE_LENGTH

    def test_multiline_message_split(self) -> None:
        """Test splitting multiline messages."""
        lines = [f"Line {i}: Some content here" for i in range(100)]
        msg = "\n".join(lines)
        parts = split_message(msg)
        for part in parts:
            assert len(part) <= MAX_MESSAGE_LENGTH

    def test_empty_message(self) -> None:
        """Test empty message."""
        parts = split_message("")
        assert len(parts) == 1
        assert parts[0] == ""

    def test_message_at_limit(self) -> None:
        """Test message at exactly the limit."""
        msg = "a" * MAX_MESSAGE_LENGTH
        parts = split_message(msg)
        assert len(parts) == 1
        assert len(parts[0]) == MAX_MESSAGE_LENGTH


class TestDiscordService:
    """Tests for DiscordService."""

    def test_service_creation(self) -> None:
        """Test creating a service."""
        config = DiscordConfig(
            token="test_token",
            application_id="123456789012345678",
        )
        service = DiscordService(config)

        assert service.config.token == "test_token"
        assert service.is_running is False

    def test_on_event_decorator(self) -> None:
        """Test event callback registration."""
        config = DiscordConfig(
            token="test_token",
            application_id="123456789012345678",
        )
        service = DiscordService(config)

        @service.on_event
        async def handler(event_type, payload):
            pass

        assert len(service._event_callbacks) == 1

    def test_on_message_decorator(self) -> None:
        """Test message callback registration."""
        config = DiscordConfig(
            token="test_token",
            application_id="123456789012345678",
        )
        service = DiscordService(config)

        @service.on_message
        async def handler(message):
            pass

        assert len(service._message_callbacks) == 1
