"""Pytest configuration and fixtures for integration tests."""

from __future__ import annotations

import os
from collections.abc import AsyncGenerator
from typing import TYPE_CHECKING

import pytest
import pytest_asyncio

if TYPE_CHECKING:
    from elizaos_plugin_anthropic import AnthropicClient


def pytest_configure(config: pytest.Config) -> None:
    """Configure pytest markers."""
    config.addinivalue_line(
        "markers",
        "integration: marks tests as integration tests (require ANTHROPIC_API_KEY)",
    )


def get_api_key() -> str | None:
    """Get API key from environment."""
    # Try loading from .env file
    try:
        from dotenv import load_dotenv

        load_dotenv()
    except ImportError:
        pass

    return os.environ.get("ANTHROPIC_API_KEY")


@pytest.fixture
def api_key() -> str:
    """Get the API key, skip if not available."""
    key = get_api_key()
    if not key:
        pytest.skip("ANTHROPIC_API_KEY not set")
    return key


@pytest_asyncio.fixture
async def client(api_key: str) -> AsyncGenerator[AnthropicClient, None]:
    """Create an Anthropic client for testing."""
    from elizaos_plugin_anthropic import AnthropicClient, AnthropicConfig

    config = AnthropicConfig(api_key)
    async with AnthropicClient(config) as client:
        yield client
