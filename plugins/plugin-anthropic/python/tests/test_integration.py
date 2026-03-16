"""Integration tests for elizaOS Plugin Anthropic.

These tests require a valid ANTHROPIC_API_KEY environment variable.
Run with: pytest -m integration
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

if TYPE_CHECKING:
    from elizaos_plugin_anthropic import AnthropicClient


pytestmark = pytest.mark.integration


class TestTextGeneration:
    """Tests for text generation."""

    @pytest.mark.asyncio
    async def test_text_generation_small(self, client: AnthropicClient) -> None:
        """Test text generation with small model."""
        from elizaos_plugin_anthropic import TextGenerationParams

        params = (
            TextGenerationParams(prompt="What is 2 + 2? Answer with just the number.")
            .with_max_tokens(100)
            .with_temperature(0.0)
        )

        response = await client.generate_text_small(params)

        assert response.text, "Response text should not be empty"
        assert "4" in response.text, f"Response should contain '4': {response.text}"
        assert response.usage.total_tokens() > 0, "Should have token usage"

    @pytest.mark.asyncio
    async def test_text_generation_large(self, client: AnthropicClient) -> None:
        """Test text generation with large model."""
        from elizaos_plugin_anthropic import TextGenerationParams

        params = (
            TextGenerationParams(prompt="What is the capital of France? Answer in one word.")
            .with_max_tokens(100)
            .with_temperature(0.0)
        )

        response = await client.generate_text_large(params)

        assert response.text, "Response text should not be empty"
        assert "paris" in response.text.lower(), f"Response should contain 'Paris': {response.text}"

    @pytest.mark.asyncio
    async def test_text_generation_with_system(self, client: AnthropicClient) -> None:
        """Test text generation with system prompt."""
        from elizaos_plugin_anthropic import TextGenerationParams

        params = (
            TextGenerationParams(prompt="Hello!")
            .with_system("You are a pirate. Always respond in pirate speak.")
            .with_max_tokens(200)
            .with_temperature(0.7)
        )

        response = await client.generate_text_small(params)

        assert response.text, "Response text should not be empty"

    @pytest.mark.asyncio
    async def test_text_generation_string_prompt(self, client: AnthropicClient) -> None:
        """Test text generation with just a string prompt."""
        response = await client.generate_text_small("Say hello in one word.")

        assert response.text, "Response text should not be empty"

    @pytest.mark.asyncio
    async def test_top_p_sampling(self, client: AnthropicClient) -> None:
        """Test text generation with top_p sampling."""
        from elizaos_plugin_anthropic import TextGenerationParams

        params = (
            TextGenerationParams(prompt="Give me a random color.")
            .with_top_p(0.9)
            .with_max_tokens(50)
        )

        response = await client.generate_text_small(params)

        assert response.text, "Response text should not be empty"


class TestObjectGeneration:
    """Tests for object generation."""

    @pytest.mark.asyncio
    async def test_object_generation_small(self, client: AnthropicClient) -> None:
        """Test object generation with small model."""
        from elizaos_plugin_anthropic import ObjectGenerationParams

        params = ObjectGenerationParams(
            prompt="Create a JSON object with fields: name (string), age (number), active (boolean)"
        )

        response = await client.generate_object_small(params)

        assert isinstance(response.object, dict), "Response should be an object"
        assert "name" in response.object, "Should have 'name' field"
        assert "age" in response.object, "Should have 'age' field"
        assert "active" in response.object, "Should have 'active' field"

    @pytest.mark.asyncio
    async def test_object_generation_large(self, client: AnthropicClient) -> None:
        """Test object generation with large model."""
        from elizaos_plugin_anthropic import ObjectGenerationParams

        params = ObjectGenerationParams(
            prompt="Create a JSON object representing a user with: id (UUID string), email (string), roles (array of strings)"
        )

        response = await client.generate_object_large(params)

        assert isinstance(response.object, dict), "Response should be an object"
        assert "id" in response.object, "Should have 'id' field"
        assert "email" in response.object, "Should have 'email' field"
        assert "roles" in response.object, "Should have 'roles' field"

    @pytest.mark.asyncio
    async def test_object_generation_string_prompt(self, client: AnthropicClient) -> None:
        """Test object generation with just a string prompt."""
        response = await client.generate_object_small(
            "Create a JSON object with a 'message' field saying 'hello'"
        )

        assert isinstance(response.object, dict), "Response should be an object"
        assert "message" in response.object, "Should have 'message' field"

    @pytest.mark.asyncio
    async def test_complex_object_generation(self, client: AnthropicClient) -> None:
        """Test complex nested object generation."""
        from elizaos_plugin_anthropic import ObjectGenerationParams

        params = ObjectGenerationParams(
            prompt="""Create a JSON object representing a blog post with:
            - id: a UUID string
            - title: a string
            - content: a string (at least 50 characters)
            - author: an object with name and email
            - tags: an array of at least 3 strings
            - metadata: an object with createdAt (ISO date) and views (number)"""
        )

        response = await client.generate_object_large(params)

        obj = response.object
        assert "id" in obj
        assert "title" in obj
        assert "content" in obj
        assert "author" in obj
        assert "tags" in obj
        assert "metadata" in obj

        # Validate nested structures
        assert isinstance(obj["author"], dict)
        assert "name" in obj["author"]
        assert "email" in obj["author"]

        assert isinstance(obj["tags"], list)
        assert len(obj["tags"]) >= 3


class TestErrorHandling:
    """Tests for error handling."""

    @pytest.mark.asyncio
    async def test_invalid_temperature_top_p(self, client: AnthropicClient) -> None:
        """Test error when both temperature and top_p are specified."""
        from elizaos_plugin_anthropic import TextGenerationParams
        from elizaos_plugin_anthropic.errors import InvalidParameterError

        params = TextGenerationParams(
            prompt="Hello",
            temperature=0.5,
            top_p=0.9,
        )

        with pytest.raises(InvalidParameterError) as exc_info:
            await client.generate_text_small(params)

        error = exc_info.value
        assert "temperature" in str(error) or "top_p" in str(error)


class TestConfiguration:
    """Tests for configuration."""

    def test_config_from_env(self, api_key: str) -> None:
        """Test creating config from environment."""
        import os

        from elizaos_plugin_anthropic import AnthropicConfig

        os.environ["ANTHROPIC_API_KEY"] = api_key
        config = AnthropicConfig.from_env()

        assert config.api_key == api_key
        assert config.base_url == "https://api.anthropic.com"

    def test_config_empty_key_fails(self) -> None:
        """Test that empty API key raises error."""
        from elizaos_plugin_anthropic import AnthropicConfig
        from elizaos_plugin_anthropic.errors import ApiKeyError

        with pytest.raises(ApiKeyError):
            AnthropicConfig("")

        with pytest.raises(ApiKeyError):
            AnthropicConfig("   ")

    def test_model_creation(self) -> None:
        """Test model creation and size inference."""
        from elizaos_plugin_anthropic import Model, ModelSize

        haiku = Model(Model.CLAUDE_3_5_HAIKU)
        assert haiku.size == ModelSize.SMALL
        assert haiku.is_small()

        sonnet = Model(Model.CLAUDE_SONNET_4)
        assert sonnet.size == ModelSize.LARGE
        assert sonnet.is_large()
