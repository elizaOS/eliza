"""Integration tests for Twitter and Grok clients."""

from __future__ import annotations

import pytest

from elizaos_plugin_twitter import GrokClient, TwitterClient
from elizaos_plugin_twitter.grok import EmbeddingParams, TextGenerationParams
from tests.conftest import skip_if_no_grok, skip_if_no_twitter_auth


class TestTwitterClient:
    """Tests for TwitterClient."""

    @skip_if_no_twitter_auth()
    async def test_get_profile(self, twitter_client: TwitterClient) -> None:
        """Test fetching a user profile."""
        profile = await twitter_client.get_profile("elikitten")
        assert profile.id
        assert profile.username.lower() == "elikitten"

    @skip_if_no_twitter_auth()
    async def test_me(self, twitter_client: TwitterClient) -> None:
        """Test fetching authenticated user's profile."""
        me = await twitter_client.me()
        assert me.id
        assert me.username


class TestGrokClient:
    """Tests for GrokClient."""

    @skip_if_no_grok()
    async def test_text_generation(self, grok_client: GrokClient) -> None:
        """Test text generation with Grok."""
        if grok_client is None:
            pytest.skip("Grok not configured")

        params = TextGenerationParams(
            prompt="Say hello in exactly 5 words.",
            max_tokens=50,
        )
        result = await grok_client.generate_text(params)

        assert result.text
        assert len(result.text) > 0

    @skip_if_no_grok()
    async def test_embedding(self, grok_client: GrokClient) -> None:
        """Test embedding generation with Grok."""
        if grok_client is None:
            pytest.skip("Grok not configured")

        params = EmbeddingParams(text="Hello, world!")
        embedding = await grok_client.create_embedding(params)

        assert isinstance(embedding, list)
        assert len(embedding) > 0
        assert all(isinstance(v, float) for v in embedding)

    @skip_if_no_grok()
    async def test_streaming(self, grok_client: GrokClient) -> None:
        """Test streaming text generation."""
        if grok_client is None:
            pytest.skip("Grok not configured")

        params = TextGenerationParams(
            prompt="Count from 1 to 5.",
            max_tokens=50,
            stream=True,
        )

        chunks: list[str] = []
        async for chunk in grok_client.stream_text(params):
            chunks.append(chunk)

        assert len(chunks) > 0
        full_text = "".join(chunks)
        assert len(full_text) > 0

