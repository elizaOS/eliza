"""Pytest configuration and fixtures."""

import pytest


@pytest.fixture
def mock_config() -> dict[str, str]:
    """Return mock configuration for testing."""
    return {
        "handle": "test.bsky.social",
        "password": "test-password",
        "service": "https://bsky.social",
    }


