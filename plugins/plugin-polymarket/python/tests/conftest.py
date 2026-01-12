"""Pytest configuration for Polymarket plugin tests."""

import pytest


def pytest_configure(config: pytest.Config) -> None:
    """Configure pytest markers."""
    config.addinivalue_line(
        "markers",
        "asyncio: mark test as async",
    )
