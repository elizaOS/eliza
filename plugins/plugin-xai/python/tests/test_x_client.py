"""Tests for X client."""

import pytest

from elizaos_plugin_xai.client import TwitterClient, TwitterConfig
from elizaos_plugin_xai.types import AuthMode


@pytest.fixture
def x_config() -> TwitterConfig:
    """Create a test X configuration."""
    return TwitterConfig(
        auth_mode=AuthMode.ENV,
        api_key="test_key",
        api_secret="test_secret",  # noqa: S106
        access_token="test_token",  # noqa: S106
        access_token_secret="test_token_secret",  # noqa: S106
    )


@pytest.mark.asyncio
async def test_x_client_creation(x_config: TwitterConfig) -> None:
    """Test X client can be created."""
    client = TwitterClient(x_config)
    assert client is not None
    await client.close()


def test_x_config_from_env() -> None:
    """Test X config defaults."""
    config = TwitterConfig()
    assert config.auth_mode == AuthMode.ENV
    assert config.max_post_length == 280
    assert config.dry_run is False
