"""Pytest configuration and fixtures for Bluesky agent tests."""

from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from elizaos import string_to_uuid


@pytest.fixture
def mock_runtime() -> MagicMock:
    """Create a mock AgentRuntime for testing."""
    runtime = MagicMock()
    runtime.agent_id = string_to_uuid("test-agent")
    runtime.character = MagicMock()
    runtime.character.name = "TestBot"
    runtime.character.bio = "A test bot"
    runtime.character.post_examples = ["Test post 1", "Test post 2"]

    runtime.logger = MagicMock()

    # Mock message_service
    runtime.message_service = MagicMock()
    runtime.message_service.handle_message = AsyncMock(
        return_value=MagicMock(
            did_respond=True,
            response_content=MagicMock(text="Test response"),
            response_messages=[],
            mode="actions",
        )
    )

    # Mock services
    mock_post = MagicMock()
    mock_post.uri = "at://did:plc:test/app.bsky.feed.post/123"
    mock_post.cid = "bafyreic123"

    mock_client = MagicMock()
    mock_client.send_post = AsyncMock(return_value=mock_post)

    mock_service = MagicMock()
    mock_service.client = mock_client

    runtime.services = {"bluesky": [mock_service]}

    # Mock other runtime methods
    runtime.ensure_connection = AsyncMock()
    runtime.register_event = MagicMock()
    runtime.emit_event = AsyncMock()

    return runtime


@pytest.fixture
def mock_notification() -> MagicMock:
    """Create a mock BlueSky notification."""
    notification = MagicMock()
    notification.uri = "at://did:plc:user123/app.bsky.feed.post/abc123"
    notification.cid = "bafyreic456"
    notification.author = MagicMock()
    notification.author.did = "did:plc:user123"
    notification.author.handle = "testuser.bsky.social"
    notification.author.display_name = "Test User"
    notification.reason = "mention"
    notification.record = {"text": "@TestBot hello!"}
    notification.is_read = False
    notification.indexed_at = "2025-01-12T00:00:00Z"

    return notification
