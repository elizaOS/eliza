"""Pytest configuration and fixtures."""

from __future__ import annotations

import os
from typing import AsyncIterator

import pytest

from elizaos_plugin_twitter import GrokClient, GrokConfig, TwitterClient, TwitterConfig


@pytest.fixture
def twitter_config() -> TwitterConfig:
    """Create Twitter config from environment or mock values."""
    return TwitterConfig.from_env()


@pytest.fixture
def grok_config() -> GrokConfig | None:
    """Create Grok config from environment."""
    return GrokConfig.from_env()


@pytest.fixture
async def twitter_client(twitter_config: TwitterConfig) -> AsyncIterator[TwitterClient]:
    """Create Twitter client fixture."""
    client = TwitterClient(twitter_config)
    yield client
    await client.close()


@pytest.fixture
async def grok_client(grok_config: GrokConfig | None) -> AsyncIterator[GrokClient | None]:
    """Create Grok client fixture."""
    if grok_config is None:
        yield None
        return
    client = GrokClient(grok_config)
    yield client
    await client.close()


def skip_if_no_twitter_auth() -> pytest.MarkDecorator:
    """Skip test if Twitter auth is not configured."""
    has_auth = bool(os.getenv("TWITTER_API_KEY"))
    return pytest.mark.skipif(not has_auth, reason="Twitter API credentials not configured")


def skip_if_no_grok() -> pytest.MarkDecorator:
    """Skip test if Grok is not configured."""
    has_grok = bool(os.getenv("XAI_API_KEY"))
    return pytest.mark.skipif(not has_grok, reason="XAI_API_KEY not configured")

