"""Integration tests for the OpenRouter client.

These tests require a valid API key.
Run with: OPENROUTER_API_KEY=your-key pytest tests/test_integration.py
"""

from __future__ import annotations

import os

import pytest

from elizaos_plugin_openrouter import OpenRouterClient, OpenRouterConfig


@pytest.fixture
def config() -> OpenRouterConfig:
    """Create configuration from environment."""
    return OpenRouterConfig.from_env()


@pytest.fixture
async def client(config: OpenRouterConfig) -> OpenRouterClient:
    """Create an async client."""
    async with OpenRouterClient(config) as client:
        yield client


@pytest.mark.skipif(
    os.environ.get("OPENROUTER_INTEGRATION_TESTS") != "1",
    reason="Integration tests disabled. Set OPENROUTER_INTEGRATION_TESTS=1 to enable.",
)
class TestOpenRouterIntegration:
    """Integration tests for OpenRouter client."""

    async def test_list_models(self, client: OpenRouterClient) -> None:
        """Test listing available models."""
        models = await client.list_models()
        assert isinstance(models, list)
        assert len(models) > 0

    async def test_generate_text_small(self, client: OpenRouterClient) -> None:
        """Test text generation with small model."""
        response = await client.generate_text_small("Say hello in one word.")
        assert response.text
        assert response.model

    async def test_generate_text_large(self, client: OpenRouterClient) -> None:
        """Test text generation with large model."""
        response = await client.generate_text_large("What is 2+2? Answer with just the number.")
        assert response.text
        assert "4" in response.text

    async def test_generate_object_small(self, client: OpenRouterClient) -> None:
        """Test object generation with small model."""
        response = await client.generate_object_small(
            "Generate a simple JSON object with a 'message' field containing 'hello'"
        )
        assert isinstance(response.object, dict)

    async def test_generate_embedding(self, client: OpenRouterClient) -> None:
        """Test embedding generation."""
        response = await client.generate_embedding("Hello, world!")
        assert response.embedding
        assert len(response.embedding) > 0
        assert all(isinstance(x, float) for x in response.embedding)


class TestConfig:
    """Tests for OpenRouterConfig."""

    def test_config_from_key(self, mock_api_key: str) -> None:
        """Test configuration with API key."""
        config = OpenRouterConfig(api_key=mock_api_key)
        assert config.api_key == mock_api_key
        assert config.base_url == "https://openrouter.ai/api/v1"

    def test_config_custom(self, mock_api_key: str) -> None:
        """Test custom configuration values."""
        config = OpenRouterConfig(
            api_key=mock_api_key,
            base_url="https://custom.api.com/v1",
            small_model="custom-small",
            large_model="custom-large",
        )
        assert config.base_url == "https://custom.api.com/v1"
        assert config.small_model == "custom-small"
        assert config.large_model == "custom-large"

    def test_urls(self, mock_api_key: str) -> None:
        """Test URL generation."""
        config = OpenRouterConfig(api_key=mock_api_key)
        assert config.chat_completions_url == "https://openrouter.ai/api/v1/chat/completions"
        assert config.embeddings_url == "https://openrouter.ai/api/v1/embeddings"

