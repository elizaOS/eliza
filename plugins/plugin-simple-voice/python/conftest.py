"""Pytest configuration for plugin-simple-voice tests."""

import pytest


def pytest_configure(config: pytest.Config) -> None:
    """Configure pytest settings."""
    # Register asyncio marker for async test functions
    config.addinivalue_line("markers", "asyncio: mark test as async")
