"""Integration tests for the OpenAI plugin."""

import os

import pytest

# Check if API key is available
HAS_API_KEY = bool(os.environ.get("OPENAI_API_KEY"))


class TestOpenAIPluginStructure:
    """Tests for plugin structure (no API key needed)."""

    def test_import_plugin(self) -> None:
        """Test that plugin can be imported."""
        from elizaos_plugin_openai import OpenAIPlugin

        assert OpenAIPlugin is not None

    def test_import_client(self) -> None:
        """Test that client can be imported."""
        from elizaos_plugin_openai import OpenAIClient

        assert OpenAIClient is not None

    def test_plugin_has_research_method(self) -> None:
        """Test that plugin exposes deep research method."""
        from elizaos_plugin_openai import OpenAIPlugin

        assert hasattr(OpenAIPlugin, "deep_research")

    def test_import_types(self) -> None:
        """Test that types can be imported."""
        from elizaos_plugin_openai import (
            EmbeddingParams,
            OpenAIConfig,
            ResearchParams,
            ResearchResult,
            TextGenerationParams,
        )

        assert OpenAIConfig is not None
        assert TextGenerationParams is not None
        assert EmbeddingParams is not None
        assert ResearchParams is not None
        assert ResearchResult is not None


class TestOpenAITokenization:
    """Tests for tokenization (no API key needed)."""

    def test_tokenize(self) -> None:
        """Test text tokenization."""
        from elizaos_plugin_openai import tokenize

        tokens = tokenize("Hello, world!")
        assert isinstance(tokens, list)
        assert len(tokens) > 0

    def test_detokenize(self) -> None:
        """Test token detokenization."""
        from elizaos_plugin_openai import detokenize, tokenize

        original = "Hello, world!"
        tokens = tokenize(original)
        decoded = detokenize(tokens)
        assert decoded == original

    def test_count_tokens(self) -> None:
        """Test token counting."""
        from elizaos_plugin_openai import count_tokens

        count = count_tokens("Hello, world!")
        assert count > 0

    def test_truncate_to_token_limit(self) -> None:
        """Test text truncation to token limit."""
        from elizaos_plugin_openai import truncate_to_token_limit

        text = "This is a longer text that might exceed token limits."
        truncated = truncate_to_token_limit(text, 5)
        assert len(truncated) <= len(text)


class TestOpenAIConfig:
    """Tests for configuration."""

    def test_config_creation(self) -> None:
        """Test config creation."""
        from elizaos_plugin_openai import OpenAIConfig

        config = OpenAIConfig(api_key="sk-test-key-1234567890")
        assert config.api_key == "sk-test-key-1234567890"

    def test_config_defaults(self) -> None:
        """Test config defaults."""
        from elizaos_plugin_openai import OpenAIConfig

        config = OpenAIConfig(api_key="sk-test-key-1234567890")
        assert config.base_url is not None


@pytest.mark.skipif(not HAS_API_KEY, reason="OPENAI_API_KEY not set")
class TestOpenAIAPIIntegration:
    """Tests that require API key."""

    @pytest.mark.asyncio
    async def test_plugin_initialization(self) -> None:
        """Test plugin initialization with real API key."""
        from elizaos_plugin_openai import get_openai_plugin

        plugin = get_openai_plugin()
        assert plugin is not None
