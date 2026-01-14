"""Integration tests that require a real API key.

These tests are marked with `pytest.mark.integration` and are skipped by default.
To run them, set the AI_GATEWAY_API_KEY environment variable and run:
    pytest tests/test_integration.py -m integration
"""

import pytest

from elizaos_plugin_gateway import GatewayConfig, GatewayPlugin


@pytest.mark.integration
@pytest.mark.asyncio
async def test_text_generation(api_key: str) -> None:
    """Test text generation with real API."""
    GatewayConfig(api_key=api_key)
    async with GatewayPlugin(api_key=api_key) as plugin:
        response = await plugin.generate_text_small("Say hello in 5 words.")
        assert isinstance(response, str)
        assert len(response) > 0


@pytest.mark.integration
@pytest.mark.asyncio
async def test_embedding_generation(api_key: str) -> None:
    """Test embedding generation with real API."""
    async with GatewayPlugin(api_key=api_key) as plugin:
        embedding = await plugin.create_embedding("Hello, world!")
        assert isinstance(embedding, list)
        assert len(embedding) > 0
        assert all(isinstance(x, float) for x in embedding)


@pytest.mark.integration
@pytest.mark.asyncio
async def test_object_generation(api_key: str) -> None:
    """Test object generation with real API."""
    async with GatewayPlugin(api_key=api_key) as plugin:
        result = await plugin.generate_object(
            "Return a JSON object with name (string) and age (number)"
        )
        assert isinstance(result, dict)


@pytest.mark.integration
@pytest.mark.asyncio
async def test_streaming(api_key: str) -> None:
    """Test streaming text generation with real API."""
    async with GatewayPlugin(api_key=api_key) as plugin:
        chunks: list[str] = []
        async for chunk in plugin.stream_text("Count from 1 to 3."):
            chunks.append(chunk)
        assert len(chunks) > 0
        result = "".join(chunks)
        assert len(result) > 0
