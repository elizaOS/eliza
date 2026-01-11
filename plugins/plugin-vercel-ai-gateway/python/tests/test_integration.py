"""Integration tests for Vercel AI Gateway plugin."""

import pytest

from elizaos_plugin_gateway import GatewayConfig, GatewayPlugin


@pytest.mark.asyncio
async def test_text_generation(api_key: str) -> None:
    """Test text generation."""
    config = GatewayConfig(api_key=api_key)
    async with GatewayPlugin(api_key=api_key) as plugin:
        response = await plugin.generate_text_small("Say hello in 5 words.")
        assert isinstance(response, str)
        assert len(response) > 0


@pytest.mark.asyncio
async def test_embedding_generation(api_key: str) -> None:
    """Test embedding generation."""
    async with GatewayPlugin(api_key=api_key) as plugin:
        embedding = await plugin.create_embedding("Hello, world!")
        assert isinstance(embedding, list)
        assert len(embedding) > 0
        assert all(isinstance(x, float) for x in embedding)


@pytest.mark.asyncio
async def test_object_generation(api_key: str) -> None:
    """Test structured object generation."""
    async with GatewayPlugin(api_key=api_key) as plugin:
        result = await plugin.generate_object(
            "Return a JSON object with name (string) and age (number)"
        )
        assert isinstance(result, dict)


@pytest.mark.asyncio
async def test_streaming(api_key: str) -> None:
    """Test streaming text generation."""
    async with GatewayPlugin(api_key=api_key) as plugin:
        chunks: list[str] = []
        async for chunk in plugin.stream_text("Count from 1 to 3."):
            chunks.append(chunk)
        assert len(chunks) > 0
        result = "".join(chunks)
        assert len(result) > 0


