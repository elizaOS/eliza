from __future__ import annotations

import os
from collections.abc import AsyncGenerator

import pytest
import pytest_asyncio
from dotenv import load_dotenv

from elizaos_plugin_google_genai import GoogleGenAIClient, GoogleGenAIConfig

load_dotenv()


def get_api_key() -> str | None:
    return os.environ.get("GOOGLE_GENERATIVE_AI_API_KEY")


@pytest.fixture
def api_key() -> str:
    key = get_api_key()
    if not key:
        pytest.skip("GOOGLE_GENERATIVE_AI_API_KEY not set")
    return key


@pytest.fixture
def config(api_key: str) -> GoogleGenAIConfig:
    return GoogleGenAIConfig(api_key)


@pytest_asyncio.fixture
async def client(config: GoogleGenAIConfig) -> AsyncGenerator[GoogleGenAIClient, None]:
    async with GoogleGenAIClient(config) as client:
        yield client
