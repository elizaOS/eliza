"""Pytest configuration and fixtures for browser plugin tests."""

import pytest

from elizaos_browser.types import BrowserConfig


@pytest.fixture
def browser_config() -> BrowserConfig:
    """Create a test browser configuration."""
    return BrowserConfig(
        headless=True,
        server_port=3456,
    )
