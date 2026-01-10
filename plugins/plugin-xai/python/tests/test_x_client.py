"""Tests for X client."""

import pytest
from elizaos_plugin_xai.client import XClient, XConfig
from elizaos_plugin_xai.types import AuthMode


@pytest.fixture
def x_config() -> XConfig:
    """Create a test X configuration."""
    return XConfig(
        auth_mode=AuthMode.ENV,
        api_key="test_key",
        api_secret="test_secret",
        access_token="test_token",
        access_token_secret="test_token_secret",
    )


@pytest.mark.asyncio
async def test_x_client_creation(x_config: XConfig) -> None:
    """Test X client can be created."""
    client = XClient(x_config)
    assert client is not None
    await client.close()


def test_x_config_from_env() -> None:
    """Test X config defaults."""
    config = XConfig()
    assert config.auth_mode == AuthMode.ENV
    assert config.max_post_length == 280
    assert config.dry_run is False

