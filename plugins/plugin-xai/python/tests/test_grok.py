"""Tests for Grok client."""

import pytest

from elizaos_plugin_xai.grok import GrokClient, GrokConfig, TextGenerationParams


@pytest.fixture
def grok_config() -> GrokConfig:
    """Create a test Grok configuration."""
    return GrokConfig(api_key="test_key")


@pytest.mark.asyncio
async def test_grok_client_creation(grok_config: GrokConfig) -> None:
    """Test Grok client can be created."""
    client = GrokClient(grok_config)
    assert client is not None
    await client.close()


def test_text_generation_params() -> None:
    """Test text generation params."""
    params = TextGenerationParams(
        prompt="Hello",
        system="You are helpful",
        temperature=0.5,
        max_tokens=100,
    )
    assert params.prompt == "Hello"
    assert params.system == "You are helpful"
    assert params.temperature == 0.5
    assert params.max_tokens == 100


def test_grok_config_defaults() -> None:
    """Test Grok config defaults."""
    config = GrokConfig(api_key="test")
    assert config.base_url == "https://api.x.ai/v1"
    assert config.small_model == "grok-3-mini"
    assert config.large_model == "grok-3"
    assert config.embedding_model == "grok-embedding"
