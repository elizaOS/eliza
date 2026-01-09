"""
Tests for Bootstrap Plugin providers.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from elizaos_plugin_bootstrap.providers import (
    character_provider,
    current_time_provider,
    recent_messages_provider,
)
from tests.conftest import MockMemory, MockState


class TestCharacterProvider:
    """Tests for the CHARACTER provider."""

    @pytest.mark.asyncio
    async def test_character_provider_name(self) -> None:
        """Test that CHARACTER provider has correct name."""
        assert character_provider.name == "CHARACTER"

    @pytest.mark.asyncio
    async def test_character_provider_returns_character_info(
        self,
        mock_runtime: MagicMock,
        mock_message: MockMemory,
    ) -> None:
        """Test that CHARACTER provider returns character information."""
        result = await character_provider.get(
            runtime=mock_runtime,
            message=mock_message,
        )

        assert result.values["agentName"] == "TestAgent"
        assert result.values["hasCharacter"] is True
        assert "TestAgent" in result.text


class TestCurrentTimeProvider:
    """Tests for the CURRENT_TIME provider."""

    @pytest.mark.asyncio
    async def test_current_time_provider_name(self) -> None:
        """Test that CURRENT_TIME provider has correct name."""
        assert current_time_provider.name == "CURRENT_TIME"

    @pytest.mark.asyncio
    async def test_current_time_provider_returns_time(
        self,
        mock_runtime: MagicMock,
        mock_message: MockMemory,
    ) -> None:
        """Test that CURRENT_TIME provider returns time information."""
        result = await current_time_provider.get(
            runtime=mock_runtime,
            message=mock_message,
        )

        assert "currentTime" in result.values
        assert "currentDate" in result.values
        assert "dayOfWeek" in result.values
        assert result.data["iso"] is not None


class TestRecentMessagesProvider:
    """Tests for the RECENT_MESSAGES provider."""

    @pytest.mark.asyncio
    async def test_recent_messages_provider_name(self) -> None:
        """Test that RECENT_MESSAGES provider has correct name."""
        assert recent_messages_provider.name == "RECENT_MESSAGES"

    @pytest.mark.asyncio
    async def test_recent_messages_with_no_room(
        self,
        mock_runtime: MagicMock,
    ) -> None:
        """Test RECENT_MESSAGES with no room returns empty."""
        message = MockMemory()  # No room_id

        result = await recent_messages_provider.get(
            runtime=mock_runtime,
            message=message,
        )

        assert result.values["messageCount"] == 0
        assert result.values["hasHistory"] is False

