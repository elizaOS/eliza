"""Pytest configuration and fixtures."""

from __future__ import annotations

import os
from collections.abc import Generator
from typing import TYPE_CHECKING

import pytest

if TYPE_CHECKING:
    from elizaos_plugin_n8n import N8nConfig, PluginCreationClient


def pytest_configure(config: pytest.Config) -> None:
    """Configure pytest markers."""
    config.addinivalue_line(
        "markers",
        "integration: marks tests as integration tests (require ANTHROPIC_API_KEY)",
    )


@pytest.fixture
def mock_api_key() -> str:
    """Return a mock API key for testing."""
    return "test-api-key-12345"


@pytest.fixture
def config(mock_api_key: str) -> N8nConfig:
    """Create a test configuration."""
    try:
        from elizaos_plugin_n8n import N8nConfig
    except ImportError:
        pytest.skip("elizaos_plugin_n8n dependencies not installed")
    return N8nConfig(api_key=mock_api_key)


@pytest.fixture
def client(config: N8nConfig) -> Generator[PluginCreationClient, None, None]:
    """Create a test client."""
    try:
        from elizaos_plugin_n8n import PluginCreationClient
    except ImportError:
        pytest.skip("elizaos_plugin_n8n dependencies not installed")
    client = PluginCreationClient(config)
    yield client


@pytest.fixture
def valid_plugin_spec() -> dict:
    """Return a valid plugin specification."""
    return {
        "name": "@test/plugin-example",
        "description": "A test plugin for testing purposes",
        "version": "2.0.0-alpha",
        "actions": [
            {
                "name": "testAction",
                "description": "A test action",
            }
        ],
    }


@pytest.fixture
def env_with_api_key(mock_api_key: str) -> Generator[None, None, None]:
    """Set up environment with API key."""
    original = os.environ.get("ANTHROPIC_API_KEY")
    os.environ["ANTHROPIC_API_KEY"] = mock_api_key
    yield
    if original:
        os.environ["ANTHROPIC_API_KEY"] = original
    else:
        os.environ.pop("ANTHROPIC_API_KEY", None)
