from __future__ import annotations

import os

import pytest

from elizaos_plugin_ollama import OllamaClient, OllamaConfig


@pytest.fixture
def config() -> OllamaConfig:
    return OllamaConfig.from_env()


@pytest.fixture
async def client(config: OllamaConfig) -> OllamaClient:
    async with OllamaClient(config) as client:
        yield client


@pytest.mark.skipif(
    os.environ.get("OLLAMA_INTEGRATION_TESTS") != "1",
    reason="Integration tests disabled. Set OLLAMA_INTEGRATION_TESTS=1 to enable.",
)
class TestOllamaIntegration:
    async def test_list_models(self, client: OllamaClient) -> None:
        models = await client.list_models()
        assert isinstance(models, list)

    async def test_generate_text_small(self, client: OllamaClient) -> None:
        response = await client.generate_text_small("Say hello in one word.")
        assert response.text
        assert response.model

    async def test_generate_text_large(self, client: OllamaClient) -> None:
        response = await client.generate_text_large("What is 2+2? Answer with just the number.")
        assert response.text
        assert "4" in response.text

    async def test_generate_object_small(self, client: OllamaClient) -> None:
        response = await client.generate_object_small(
            "Generate a simple JSON object with a 'message' field containing 'hello'"
        )
        assert isinstance(response.object, dict)

    async def test_generate_embedding(self, client: OllamaClient) -> None:
        response = await client.generate_embedding("Hello, world!")
        assert response.embedding
        assert len(response.embedding) > 0
        assert all(isinstance(x, float) for x in response.embedding)


class TestConfig:
    def test_config_defaults(self) -> None:
        config = OllamaConfig()
        assert config.base_url == "http://localhost:11434"
        assert config.small_model == "gemma3:latest"
        assert config.large_model == "gemma3:latest"
        assert config.embedding_model == "nomic-embed-text:latest"

    def test_config_custom(self) -> None:
        config = OllamaConfig(
            base_url="http://custom:8080",
            small_model="custom-small",
            large_model="custom-large",
        )
        assert config.base_url == "http://custom:8080"
        assert config.small_model == "custom-small"
        assert config.large_model == "custom-large"

    def test_generate_url(self) -> None:
        config = OllamaConfig(base_url="http://localhost:11434")
        assert config.generate_url == "http://localhost:11434/api/generate"
        assert config.embeddings_url == "http://localhost:11434/api/embeddings"
