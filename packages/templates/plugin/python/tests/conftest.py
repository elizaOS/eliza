"""
Pytest configuration for the Python plugin starter tests.
"""

import pytest


@pytest.fixture
def mock_runtime():
    """Create a mock runtime for testing."""
    from unittest.mock import MagicMock

    runtime = MagicMock()
    return runtime


@pytest.fixture
def sample_config() -> dict[str, str]:
    """Sample plugin configuration for testing."""
    return {
        "EXAMPLE_PLUGIN_VARIABLE": "test-value",
    }
