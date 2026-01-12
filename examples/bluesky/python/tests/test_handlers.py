"""Tests for Bluesky event handlers."""

from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, MagicMock

from handlers import handle_mention_received, handle_create_post


class TestHandleMentionReceived:
    """Tests for the mention handler."""

    @pytest.mark.asyncio
    async def test_processes_mention(self, mock_runtime, mock_client, mock_notification):
        """Should process a mention and generate a reply."""
        mock_notification.reason = "mention"
        mock_notification.record = {"text": "@TestBot what is AI?"}

        await handle_mention_received(mock_runtime, mock_client, mock_notification)

        # Should have generated text
        mock_runtime.generate_text.assert_called_once()

        # Should have posted reply
        mock_client.send_post.assert_called_once()

    @pytest.mark.asyncio
    async def test_skips_non_mention(self, mock_runtime, mock_client, mock_notification):
        """Should skip non-mention notifications."""
        mock_notification.reason = "follow"

        await handle_mention_received(mock_runtime, mock_client, mock_notification)

        mock_runtime.generate_text.assert_not_called()
        mock_client.send_post.assert_not_called()

    @pytest.mark.asyncio
    async def test_skips_empty_text(self, mock_runtime, mock_client, mock_notification):
        """Should skip empty mention text."""
        mock_notification.reason = "mention"
        mock_notification.record = {"text": ""}

        await handle_mention_received(mock_runtime, mock_client, mock_notification)

        mock_runtime.generate_text.assert_not_called()

    @pytest.mark.asyncio
    async def test_handles_reply_notification(
        self, mock_runtime, mock_client, mock_notification
    ):
        """Should handle reply notifications."""
        mock_notification.reason = "reply"
        mock_notification.record = {"text": "Thanks!"}

        await handle_mention_received(mock_runtime, mock_client, mock_notification)

        mock_runtime.generate_text.assert_called_once()

    @pytest.mark.asyncio
    async def test_handles_empty_generated_reply(
        self, mock_runtime, mock_client, mock_notification
    ):
        """Should handle empty generated reply."""
        mock_notification.reason = "mention"
        mock_notification.record = {"text": "@TestBot hello"}
        mock_runtime.generate_text = AsyncMock(return_value=MagicMock(text=""))

        await handle_mention_received(mock_runtime, mock_client, mock_notification)

        mock_client.send_post.assert_not_called()

    @pytest.mark.asyncio
    async def test_handles_post_error(
        self, mock_runtime, mock_client, mock_notification
    ):
        """Should handle errors when posting."""
        mock_notification.reason = "mention"
        mock_notification.record = {"text": "@TestBot hello"}
        mock_client.send_post = AsyncMock(side_effect=Exception("Network error"))

        # Should not raise
        await handle_mention_received(mock_runtime, mock_client, mock_notification)


class TestHandleCreatePost:
    """Tests for automated post creation."""

    @pytest.mark.asyncio
    async def test_generates_post(self, mock_runtime, mock_client):
        """Should generate and post automated content."""
        await handle_create_post(mock_runtime, mock_client)

        mock_runtime.generate_text.assert_called_once()
        mock_client.send_post.assert_called_once()

    @pytest.mark.asyncio
    async def test_handles_empty_generated_post(self, mock_runtime, mock_client):
        """Should handle empty generated post."""
        mock_runtime.generate_text = AsyncMock(return_value=MagicMock(text=""))

        await handle_create_post(mock_runtime, mock_client)

        mock_client.send_post.assert_not_called()

    @pytest.mark.asyncio
    async def test_handles_post_error(self, mock_runtime, mock_client):
        """Should handle errors when posting."""
        mock_client.send_post = AsyncMock(side_effect=Exception("Network error"))

        # Should not raise
        await handle_create_post(mock_runtime, mock_client)


class TestCharacter:
    """Tests for character configuration."""

    def test_character_has_required_fields(self):
        """Character should have all required fields."""
        from character import character

        assert character.name is not None
        assert character.bio is not None
        assert character.system is not None

    def test_character_has_examples(self):
        """Character should have message and post examples."""
        from character import character

        assert character.message_examples is not None
        assert len(character.message_examples) > 0

        assert character.post_examples is not None
        assert len(character.post_examples) > 0
