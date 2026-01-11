"""Pytest configuration and fixtures."""

from __future__ import annotations

import os

import pytest


@pytest.fixture
def mock_api_key() -> str:
    """Return a mock API key for testing."""
    return "sk-test-mock-key-12345"


@pytest.fixture
def real_api_key() -> str | None:
    """Return real API key from environment if available."""
    return os.environ.get("OPENROUTER_API_KEY")


