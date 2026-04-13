"""Pytest configuration and fixtures for Discord agent tests."""

from __future__ import annotations

import os
import pytest


@pytest.fixture(autouse=True)
def mock_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """Set up mock environment variables for testing."""
    monkeypatch.setenv("DISCORD_APPLICATION_ID", "test-app-id")
    monkeypatch.setenv("DISCORD_API_TOKEN", "test-token")
    monkeypatch.setenv("OPENAI_API_KEY", "test-openai-key")


@pytest.fixture
def sample_message() -> dict:
    """Sample Discord message payload."""
    return {
        "id": "123456789",
        "content": "Hello, bot!",
        "channel_id": "987654321",
        "author": {
            "id": "111222333",
            "username": "testuser",
            "discriminator": "0001",
        },
        "mentions": [],
        "timestamp": "2024-01-01T00:00:00.000Z",
    }


@pytest.fixture
def sample_interaction() -> dict:
    """Sample Discord interaction payload."""
    return {
        "id": "123456789",
        "name": "ping",
        "type": 2,  # Application command
        "user": {
            "id": "111222333",
            "username": "testuser",
        },
        "channel_id": "987654321",
        "guild_id": "555666777",
    }
