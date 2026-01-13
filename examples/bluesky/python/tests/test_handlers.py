"""Tests for Bluesky event handlers."""

from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, MagicMock

import sys
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from handlers import (
    create_unique_uuid,
    get_bluesky_service,
    handle_mention_received,
    handle_should_respond,
    handle_create_post,
    register_bluesky_handlers,
)


class TestCreateUniqueUuid:
    """Tests for create_unique_uuid function."""

    def test_returns_agent_id_for_same_base(self, mock_runtime: MagicMock) -> None:
        """Should return agent_id when base_id matches."""
        result = create_unique_uuid(mock_runtime, mock_runtime.agent_id)
        assert result == mock_runtime.agent_id

    def test_creates_unique_uuid_for_different_base(self, mock_runtime: MagicMock) -> None:
        """Should create a combined UUID for different base IDs."""
        result = create_unique_uuid(mock_runtime, "different-id")
        assert result != mock_runtime.agent_id


class TestGetBlueSkyService:
    """Tests for get_bluesky_service function."""

    def test_returns_service_when_available(self, mock_runtime: MagicMock) -> None:
        """Should return the BlueSky service when registered."""
        service = get_bluesky_service(mock_runtime)
        assert service is not None

    def test_returns_none_when_not_available(self, mock_runtime: MagicMock) -> None:
        """Should return None when service is not registered."""
        mock_runtime.services = {}
        service = get_bluesky_service(mock_runtime)
        assert service is None


@pytest.mark.asyncio
class TestHandleMentionReceived:
    """Tests for handle_mention_received function."""

    async def test_processes_mention_through_pipeline(
        self,
        mock_runtime: MagicMock,
        mock_notification: MagicMock,
    ) -> None:
        """Should process mentions through messageService.handleMessage()."""
        await handle_mention_received(mock_runtime, mock_notification)

        # Should have ensured connection
        mock_runtime.ensure_connection.assert_called_once()

        # Should have called message_service.handle_message()
        mock_runtime.message_service.handle_message.assert_called_once()

    async def test_skips_non_mention_notifications(
        self,
        mock_runtime: MagicMock,
        mock_notification: MagicMock,
    ) -> None:
        """Should skip notifications that aren't mentions or replies."""
        mock_notification.reason = "follow"

        await handle_mention_received(mock_runtime, mock_notification)

        mock_runtime.message_service.handle_message.assert_not_called()

    async def test_skips_empty_text(
        self,
        mock_runtime: MagicMock,
        mock_notification: MagicMock,
    ) -> None:
        """Should skip mentions with empty text."""
        mock_notification.record = {"text": ""}

        await handle_mention_received(mock_runtime, mock_notification)

        mock_runtime.message_service.handle_message.assert_not_called()

    async def test_handles_missing_message_service(
        self,
        mock_runtime: MagicMock,
        mock_notification: MagicMock,
    ) -> None:
        """Should handle missing message service gracefully."""
        mock_runtime.message_service = None

        # Should not raise
        await handle_mention_received(mock_runtime, mock_notification)

    async def test_posts_reply_via_callback(
        self,
        mock_runtime: MagicMock,
        mock_notification: MagicMock,
    ) -> None:
        """Should post reply to Bluesky via the callback."""
        # Capture the callback passed to handle_message
        captured_callback = None

        async def capture_callback(runtime, message, callback):
            nonlocal captured_callback
            captured_callback = callback
            # Simulate calling the callback with a response
            from elizaos import Content

            await callback(Content(text="Test response!"))
            return MagicMock(did_respond=True, mode="actions")

        mock_runtime.message_service.handle_message = capture_callback

        await handle_mention_received(mock_runtime, mock_notification)

        # Verify the client's send_post was called
        service = mock_runtime.services["bluesky"][0]
        service.client.send_post.assert_called_once()


@pytest.mark.asyncio
class TestHandleShouldRespond:
    """Tests for handle_should_respond function."""

    async def test_routes_mentions_to_handle_mention_received(
        self,
        mock_runtime: MagicMock,
        mock_notification: MagicMock,
    ) -> None:
        """Should route mentions to handle_mention_received."""
        mock_notification.reason = "mention"

        await handle_should_respond(mock_runtime, mock_notification)

        mock_runtime.message_service.handle_message.assert_called_once()

    async def test_routes_replies_to_handle_mention_received(
        self,
        mock_runtime: MagicMock,
        mock_notification: MagicMock,
    ) -> None:
        """Should route replies to handle_mention_received."""
        mock_notification.reason = "reply"

        await handle_should_respond(mock_runtime, mock_notification)

        mock_runtime.message_service.handle_message.assert_called_once()


@pytest.mark.asyncio
class TestHandleCreatePost:
    """Tests for handle_create_post function."""

    async def test_generates_automated_post_through_pipeline(
        self,
        mock_runtime: MagicMock,
    ) -> None:
        """Should generate automated posts through the pipeline."""
        await handle_create_post(mock_runtime, automated=True)

        mock_runtime.message_service.handle_message.assert_called_once()

    async def test_skips_non_automated_posts(
        self,
        mock_runtime: MagicMock,
    ) -> None:
        """Should skip non-automated posts."""
        await handle_create_post(mock_runtime, automated=False)

        mock_runtime.message_service.handle_message.assert_not_called()


class TestRegisterBlueSkyHandlers:
    """Tests for register_bluesky_handlers function."""

    def test_registers_all_event_handlers(self, mock_runtime: MagicMock) -> None:
        """Should register all three event handlers."""
        register_bluesky_handlers(mock_runtime)

        assert mock_runtime.register_event.call_count == 3

        # Check that all events were registered
        registered_events = [call[0][0] for call in mock_runtime.register_event.call_args_list]
        assert "bluesky.mention_received" in registered_events
        assert "bluesky.should_respond" in registered_events
        assert "bluesky.create_post" in registered_events
