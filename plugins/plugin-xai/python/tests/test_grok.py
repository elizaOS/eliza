"""Tests for Grok client."""

import os
from unittest.mock import patch

import pytest

from elizaos_plugin_xai.grok import (
    EmbeddingParams,
    GrokClient,
    GrokConfig,
    GrokError,
    TextGenerationParams,
    TextGenerationResult,
    TokenUsage,
)


# ============================================================================
# GrokConfig
# ============================================================================


class TestGrokConfig:
    """Tests for GrokConfig."""

    def test_defaults(self) -> None:
        config = GrokConfig(api_key="test")
        assert config.base_url == "https://api.x.ai/v1"
        assert config.small_model == "grok-3-mini"
        assert config.large_model == "grok-3"
        assert config.embedding_model == "grok-embedding"
        assert config.timeout == 60.0

    def test_custom_values(self) -> None:
        config = GrokConfig(
            api_key="my-key",
            base_url="https://custom.api.com/v1",
            small_model="grok-3-mini-fast",
            large_model="grok-3-turbo",
            embedding_model="grok-embed-v2",
            timeout=120.0,
        )
        assert config.api_key == "my-key"
        assert config.base_url == "https://custom.api.com/v1"
        assert config.small_model == "grok-3-mini-fast"
        assert config.large_model == "grok-3-turbo"
        assert config.embedding_model == "grok-embed-v2"
        assert config.timeout == 120.0

    def test_from_env_missing_key(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            with pytest.raises(ValueError, match="XAI_API_KEY"):
                GrokConfig.from_env()

    def test_from_env_with_key(self) -> None:
        with patch.dict(
            os.environ,
            {"XAI_API_KEY": "env-key"},
            clear=True,
        ):
            config = GrokConfig.from_env()
            assert config.api_key == "env-key"
            assert config.base_url == "https://api.x.ai/v1"

    def test_from_env_custom_values(self) -> None:
        with patch.dict(
            os.environ,
            {
                "XAI_API_KEY": "env-key",
                "XAI_BASE_URL": "https://custom.com/v1",
                "XAI_SMALL_MODEL": "custom-small",
                "XAI_MODEL": "custom-large",
                "XAI_EMBEDDING_MODEL": "custom-embed",
            },
            clear=True,
        ):
            config = GrokConfig.from_env()
            assert config.base_url == "https://custom.com/v1"
            assert config.small_model == "custom-small"
            assert config.large_model == "custom-large"
            assert config.embedding_model == "custom-embed"

    def test_from_env_large_model_fallback(self) -> None:
        """XAI_LARGE_MODEL is used when XAI_MODEL is not set."""
        with patch.dict(
            os.environ,
            {
                "XAI_API_KEY": "key",
                "XAI_LARGE_MODEL": "fallback-large",
            },
            clear=True,
        ):
            config = GrokConfig.from_env()
            assert config.large_model == "fallback-large"


# ============================================================================
# GrokError
# ============================================================================


class TestGrokError:
    """Tests for GrokError."""

    def test_construction(self) -> None:
        err = GrokError("API failed", status_code=500)
        assert str(err) == "API failed"
        assert err.status_code == 500

    def test_without_status_code(self) -> None:
        err = GrokError("Unknown error")
        assert err.status_code is None

    def test_is_exception(self) -> None:
        err = GrokError("test")
        assert isinstance(err, Exception)


# ============================================================================
# TextGenerationParams
# ============================================================================


class TestTextGenerationParams:
    """Tests for TextGenerationParams."""

    def test_minimal(self) -> None:
        params = TextGenerationParams(prompt="Hello")
        assert params.prompt == "Hello"
        assert params.system is None
        assert params.temperature == 0.7
        assert params.max_tokens is None
        assert params.stop_sequences is None
        assert params.stream is False

    def test_full(self) -> None:
        params = TextGenerationParams(
            prompt="Hello",
            system="You are helpful",
            temperature=0.5,
            max_tokens=100,
            stop_sequences=["END"],
            stream=True,
        )
        assert params.prompt == "Hello"
        assert params.system == "You are helpful"
        assert params.temperature == 0.5
        assert params.max_tokens == 100
        assert params.stop_sequences == ["END"]
        assert params.stream is True

    def test_temperature_bounds(self) -> None:
        # Valid at boundaries
        TextGenerationParams(prompt="t", temperature=0.0)
        TextGenerationParams(prompt="t", temperature=2.0)

        # Invalid
        with pytest.raises(Exception):
            TextGenerationParams(prompt="t", temperature=-0.1)
        with pytest.raises(Exception):
            TextGenerationParams(prompt="t", temperature=2.1)


# ============================================================================
# EmbeddingParams
# ============================================================================


class TestEmbeddingParams:
    """Tests for EmbeddingParams."""

    def test_construction(self) -> None:
        params = EmbeddingParams(text="Hello world")
        assert params.text == "Hello world"
        assert params.model is None

    def test_with_model(self) -> None:
        params = EmbeddingParams(text="Hello", model="custom-embed")
        assert params.model == "custom-embed"


# ============================================================================
# TokenUsage
# ============================================================================


class TestTokenUsage:
    """Tests for TokenUsage."""

    def test_defaults(self) -> None:
        usage = TokenUsage()
        assert usage.prompt_tokens == 0
        assert usage.completion_tokens == 0
        assert usage.total_tokens == 0

    def test_custom(self) -> None:
        usage = TokenUsage(prompt_tokens=10, completion_tokens=20, total_tokens=30)
        assert usage.prompt_tokens == 10
        assert usage.total_tokens == 30


# ============================================================================
# TextGenerationResult
# ============================================================================


class TestTextGenerationResult:
    """Tests for TextGenerationResult."""

    def test_construction(self) -> None:
        result = TextGenerationResult(
            text="Generated text",
            usage=TokenUsage(prompt_tokens=5, completion_tokens=10, total_tokens=15),
        )
        assert result.text == "Generated text"
        assert result.usage.total_tokens == 15

    def test_default_usage(self) -> None:
        result = TextGenerationResult(text="Hello")
        assert result.usage.total_tokens == 0


# ============================================================================
# GrokClient
# ============================================================================


class TestGrokClient:
    """Tests for GrokClient."""

    @pytest.fixture
    def grok_config(self) -> GrokConfig:
        return GrokConfig(api_key="test_key")

    @pytest.mark.asyncio
    async def test_client_creation(self, grok_config: GrokConfig) -> None:
        client = GrokClient(grok_config)
        assert client is not None
        await client.close()

    @pytest.mark.asyncio
    async def test_client_context_manager(self, grok_config: GrokConfig) -> None:
        async with GrokClient(grok_config) as client:
            assert client is not None

    @pytest.mark.asyncio
    async def test_close_idempotent(self, grok_config: GrokConfig) -> None:
        client = GrokClient(grok_config)
        await client.close()
        await client.close()  # Should not raise
