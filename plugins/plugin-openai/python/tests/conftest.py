"""
Pytest configuration and fixtures for OpenAI plugin tests.
"""

import os

import pytest

from elizaos_plugin_openai import OpenAIConfig, OpenAIPlugin


def get_api_key() -> str:
    """Get API key from environment, fail if not available."""
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        pytest.skip("OPENAI_API_KEY not set - skipping live API tests")
    return key


@pytest.fixture
def api_key() -> str:
    """Fixture that provides the API key."""
    return get_api_key()


@pytest.fixture
def openai_config(api_key: str) -> OpenAIConfig:
    """Create an OpenAI config for testing."""
    return OpenAIConfig(
        api_key=api_key,
        small_model="gpt-5-mini",
        large_model="gpt-5",
        embedding_model="text-embedding-3-small",
        embedding_dimensions=1536,
    )


@pytest.fixture
async def plugin(api_key: str) -> OpenAIPlugin:
    """Create an OpenAI plugin for testing."""
    plugin = OpenAIPlugin(api_key=api_key)
    yield plugin
    await plugin.close()
