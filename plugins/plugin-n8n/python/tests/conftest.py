"""Pytest configuration and fixtures."""

from __future__ import annotations

import os
from collections.abc import Generator

import pytest

from elizaos_plugin_n8n import N8nConfig, PluginCreationClient


@pytest.fixture
def mock_api_key() -> str:
    """Return a mock API key for testing."""
    return "test-api-key-12345"


@pytest.fixture
def config(mock_api_key: str) -> N8nConfig:
    """Create a test configuration."""
    return N8nConfig(api_key=mock_api_key)


@pytest.fixture
def client(config: N8nConfig) -> Generator[PluginCreationClient, None, None]:
    """Create a test client."""
    client = PluginCreationClient(config)
    yield client


@pytest.fixture
def valid_plugin_spec() -> dict:
    """Return a valid plugin specification."""
    return {
        "name": "@test/plugin-example",
        "description": "A test plugin for testing purposes",
        "version": "1.0.0",
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


