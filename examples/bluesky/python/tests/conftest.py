"""Pytest configuration and fixtures."""

from __future__ import annotations

import os
from pathlib import Path
from typing import TYPE_CHECKING

import pytest
from dotenv import load_dotenv

# Load environment for tests
load_dotenv(Path(__file__).parent.parent.parent / ".env")
load_dotenv()


def pytest_addoption(parser: pytest.Parser) -> None:
    """Add custom command line options."""
    parser.addoption(
        "--live",
        action="store_true",
        default=False,
        help="Run live integration tests (requires credentials)",
    )


def pytest_configure(config: pytest.Config) -> None:
    """Configure pytest markers."""
    config.addinivalue_line("markers", "live: mark test as requiring live credentials")


def pytest_collection_modifyitems(
    config: pytest.Config, items: list[pytest.Item]
) -> None:
    """Skip live tests unless --live is passed."""
    if config.getoption("--live"):
        return

    skip_live = pytest.mark.skip(reason="Use --live to run integration tests")
    for item in items:
        if "live" in item.keywords:
            item.add_marker(skip_live)


@pytest.fixture
def mock_runtime():
    """Create a mock runtime for testing."""
    from unittest.mock import AsyncMock, MagicMock
    from uuid6 import uuid7

    runtime = MagicMock()
    runtime.agent_id = uuid7()
    runtime.character = MagicMock()
    runtime.character.name = "TestBot"
    runtime.character.bio = "A test bot"
    runtime.character.post_examples = ["Test post 1", "Test post 2"]

    runtime.create_memory = AsyncMock()
    runtime.generate_text = AsyncMock(return_value=MagicMock(text="Test reply!"))

    return runtime


@pytest.fixture
def mock_client():
    """Create a mock BlueSky client for testing."""
    from unittest.mock import AsyncMock, MagicMock

    client = MagicMock()
    client.send_post = AsyncMock(
        return_value=MagicMock(uri="at://mock/post/123", cid="mock-cid-123")
    )
    client.get_notifications = AsyncMock(
        return_value=MagicMock(notifications=[])
    )
    client.update_seen_notifications = AsyncMock()

    return client


@pytest.fixture
def mock_notification():
    """Create a mock notification for testing."""
    from unittest.mock import MagicMock

    notification = MagicMock()
    notification.uri = "at://did:plc:user123/app.bsky.feed.post/abc123"
    notification.cid = "bafyreic123"
    notification.author = MagicMock()
    notification.author.did = "did:plc:user123"
    notification.author.handle = "testuser.bsky.social"
    notification.author.display_name = "Test User"
    notification.reason = "mention"
    notification.record = {"text": "@TestBot hello!"}
    notification.is_read = False
    notification.indexed_at = "2024-01-01T00:00:00Z"

    return notification
