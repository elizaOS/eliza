"""Tests for Discord event handlers."""

from __future__ import annotations

import pytest
import sys
import os

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from character import character
from handlers import generate_response


class TestCharacter:
    """Tests for the character definition."""

    def test_character_has_name(self) -> None:
        """Character should have a name."""
        assert character.name == "DiscordEliza"

    def test_character_has_bio(self) -> None:
        """Character should have a bio."""
        assert character.bio is not None
        assert len(character.bio) > 0

    def test_character_has_system_prompt(self) -> None:
        """Character should have a system prompt."""
        assert character.system is not None
        assert len(character.system) > 0

    def test_character_has_discord_settings(self) -> None:
        """Character should have Discord-specific settings."""
        assert character.settings is not None
        assert "discord" in character.settings
        assert character.settings["discord"]["shouldIgnoreBotMessages"] is True
        assert character.settings["discord"]["shouldRespondOnlyToMentions"] is True


class TestGenerateResponse:
    """Tests for the response generation function."""

    def test_hello_response(self) -> None:
        """Should respond to hello."""
        response = generate_response("hello there!", "testuser")
        assert response is not None
        assert "Hello" in response
        assert "testuser" in response

    def test_ping_response(self) -> None:
        """Should respond to ping."""
        response = generate_response("ping", "testuser")
        assert response is not None
        assert "Pong" in response

    def test_help_response(self) -> None:
        """Should respond to help."""
        response = generate_response("can you help me?", "testuser")
        assert response is not None
        assert "How I can help" in response

    def test_about_response(self) -> None:
        """Should respond to about."""
        response = generate_response("who are you?", "testuser")
        assert response is not None
        assert character.name in response

    def test_default_response(self) -> None:
        """Should have a default response."""
        response = generate_response("some random message", "bob")
        assert response is not None
        assert "bob" in response


class TestEnvironmentValidation:
    """Tests for environment validation."""

    def test_detects_missing_discord_id(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Should detect missing Discord application ID."""
        monkeypatch.delenv("DISCORD_APPLICATION_ID", raising=False)

        required = ["DISCORD_APPLICATION_ID", "DISCORD_API_TOKEN"]
        missing = [key for key in required if not os.environ.get(key)]

        assert "DISCORD_APPLICATION_ID" in missing

    def test_detects_missing_discord_token(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Should detect missing Discord API token."""
        monkeypatch.delenv("DISCORD_API_TOKEN", raising=False)

        required = ["DISCORD_APPLICATION_ID", "DISCORD_API_TOKEN"]
        missing = [key for key in required if not os.environ.get(key)]

        assert "DISCORD_API_TOKEN" in missing

    def test_passes_when_all_present(self) -> None:
        """Should pass when all required variables are present."""
        required = ["DISCORD_APPLICATION_ID", "DISCORD_API_TOKEN"]
        missing = [key for key in required if not os.environ.get(key)]

        assert len(missing) == 0


class TestMessagePayload:
    """Tests for message payload handling."""

    def test_sample_message_structure(self, sample_message: dict) -> None:
        """Sample message should have correct structure."""
        assert "content" in sample_message
        assert "channel_id" in sample_message
        assert "author" in sample_message

    def test_message_author_info(self, sample_message: dict) -> None:
        """Message should have author info."""
        assert "username" in sample_message["author"]
        assert "id" in sample_message["author"]
