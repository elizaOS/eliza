"""Pytest configuration for Instagram plugin tests."""

import sys
from collections.abc import Generator
from unittest.mock import MagicMock

import pytest


# Mock instagrapi before any imports happen
@pytest.fixture(scope="session", autouse=True)
def mock_instagrapi() -> Generator[MagicMock, None, None]:
    """Mock instagrapi module for testing without the actual dependency."""
    mock_instagrapi_module = MagicMock()
    mock_instagrapi_module.Client = MagicMock()
    mock_instagrapi_module.exceptions = MagicMock()
    mock_instagrapi_module.exceptions.LoginRequired = Exception
    mock_instagrapi_module.exceptions.TwoFactorRequired = Exception

    # Pre-inject the mock before imports
    sys.modules["instagrapi"] = mock_instagrapi_module
    sys.modules["instagrapi.exceptions"] = mock_instagrapi_module.exceptions

    yield mock_instagrapi_module

    # Cleanup
    if "instagrapi" in sys.modules:
        del sys.modules["instagrapi"]
    if "instagrapi.exceptions" in sys.modules:
        del sys.modules["instagrapi.exceptions"]


# Ensure instagrapi is mocked at module load time
def pytest_configure(config: pytest.Config) -> None:
    """Configure pytest and set up mocks before test collection."""
    mock_instagrapi_module = MagicMock()
    mock_instagrapi_module.Client = MagicMock()
    mock_instagrapi_module.exceptions = MagicMock()
    mock_instagrapi_module.exceptions.LoginRequired = Exception
    mock_instagrapi_module.exceptions.TwoFactorRequired = Exception

    sys.modules["instagrapi"] = mock_instagrapi_module
    sys.modules["instagrapi.exceptions"] = mock_instagrapi_module.exceptions
