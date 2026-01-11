"""Pytest configuration and fixtures for Google GenAI plugin tests."""

from __future__ import annotations

import os
from collections.abc import AsyncGenerator
from typing import TYPE_CHECKING

import pytest
import pytest_asyncio
from dotenv import load_dotenv

from elizaos_plugin_google_genai import GoogleGenAIClient, GoogleGenAIConfig

if TYPE_CHECKING:
    pass

# Load environment variables from .env file
load_dotenv()


def get_api_key() -> str | None:
    """Get the Google AI API key from environment."""
    return os.environ.get("GOOGLE_GENERATIVE_AI_API_KEY")


@pytest.fixture
def api_key() -> str:
    """Get the API key, skip test if not available."""
    key = get_api_key()
    if not key:
        pytest.skip("GOOGLE_GENERATIVE_AI_API_KEY not set")
    return key


@pytest.fixture
def config(api_key: str) -> GoogleGenAIConfig:
    """Create a config instance for testing."""
    return GoogleGenAIConfig(api_key)


@pytest_asyncio.fixture
async def client(config: GoogleGenAIConfig) -> AsyncGenerator[GoogleGenAIClient, None]:
    """Create a client instance for testing."""
    async with GoogleGenAIClient(config) as client:
        yield client





