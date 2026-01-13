"""Root pytest configuration for ElevenLabs plugin tests."""

import pytest


@pytest.fixture
def mock_api_key() -> str:
    """Provide a mock API key for testing."""
    return "test-api-key-12345"
