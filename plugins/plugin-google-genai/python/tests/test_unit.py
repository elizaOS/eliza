"""Unit tests for the Google GenAI plugin.

These tests don't require an API key and test internal functionality.
"""

from __future__ import annotations

import pytest

from elizaos_plugin_google_genai import (
    PLUGIN_DESCRIPTION,
    PLUGIN_NAME,
    PLUGIN_VERSION,
    GoogleGenAIConfig,
    Model,
    ModelSize,
)
from elizaos_plugin_google_genai.errors import (
    ApiKeyError,
    ConfigError,
    GoogleGenAIError,
    InvalidParameterError,
    JsonGenerationError,
)
from elizaos_plugin_google_genai.types import (
    EmbeddingParams,
    ImageDescriptionParams,
    ObjectGenerationParams,
    TextGenerationParams,
    TokenUsage,
)


class TestPluginMetadata:
    """Test plugin metadata."""

    def test_plugin_name(self) -> None:
        """Should have correct plugin name."""
        assert PLUGIN_NAME == "google-genai"

    def test_plugin_description(self) -> None:
        """Should have plugin description."""
        assert PLUGIN_DESCRIPTION
        assert len(PLUGIN_DESCRIPTION) > 0

    def test_plugin_version(self) -> None:
        """Should have plugin version."""
        assert PLUGIN_VERSION
        assert PLUGIN_VERSION == "1.0.0"


class TestModel:
    """Test Model class."""

    def test_model_creation(self) -> None:
        """Should create model from ID."""
        model = Model("gemini-2.0-flash-001")
        assert model.id == "gemini-2.0-flash-001"

    def test_model_small(self) -> None:
        """Should create default small model."""
        model = Model.small()
        assert model.id == Model.GEMINI_2_0_FLASH
        assert model.is_small()
        assert model.size == ModelSize.SMALL

    def test_model_large(self) -> None:
        """Should create default large model."""
        model = Model.large()
        assert model.id == Model.GEMINI_2_5_PRO
        assert model.is_large()
        assert model.size == ModelSize.LARGE

    def test_model_embedding(self) -> None:
        """Should create default embedding model."""
        model = Model.embedding()
        assert model.id == Model.TEXT_EMBEDDING_004
        assert model.is_embedding()
        assert model.size == ModelSize.EMBEDDING

    def test_model_default_max_tokens(self) -> None:
        """Should have correct default max tokens."""
        flash = Model(Model.GEMINI_2_0_FLASH)
        assert flash.default_max_tokens == 8192

        embedding = Model(Model.TEXT_EMBEDDING_004)
        assert embedding.default_max_tokens == 0

    def test_empty_model_id_raises(self) -> None:
        """Should raise error for empty model ID."""
        with pytest.raises(InvalidParameterError):
            Model("")
        with pytest.raises(InvalidParameterError):
            Model("   ")

    def test_model_equality(self) -> None:
        """Should support equality comparison."""
        model1 = Model("gemini-2.0-flash-001")
        model2 = Model("gemini-2.0-flash-001")
        model3 = Model("gemini-2.5-pro-preview-03-25")

        assert model1 == model2
        assert model1 != model3

    def test_model_string_representation(self) -> None:
        """Should have string representation."""
        model = Model("gemini-2.0-flash-001")
        assert str(model) == "gemini-2.0-flash-001"


class TestConfig:
    """Test GoogleGenAIConfig class."""

    def test_config_creation(self) -> None:
        """Should create config with API key."""
        config = GoogleGenAIConfig("test-api-key")
        assert config.api_key == "test-api-key"
        assert config.base_url == "https://generativelanguage.googleapis.com"

    def test_empty_key_raises(self) -> None:
        """Should raise error for empty API key."""
        with pytest.raises(ApiKeyError):
            GoogleGenAIConfig("")
        with pytest.raises(ApiKeyError):
            GoogleGenAIConfig("   ")

    def test_config_with_custom_models(self) -> None:
        """Should accept custom model configuration."""
        custom_small = Model("custom-small")
        config = GoogleGenAIConfig("test-key", small_model=custom_small)
        assert config.small_model.id == "custom-small"

    def test_config_with_timeout(self) -> None:
        """Should accept custom timeout."""
        config = GoogleGenAIConfig("test-key", timeout_seconds=120)
        assert config.timeout_seconds == 120

    def test_config_builder_pattern(self) -> None:
        """Should support builder pattern."""
        config = (
            GoogleGenAIConfig("test-key").with_base_url("https://custom.api.com").with_timeout(120)
        )

        assert config.base_url == "https://custom.api.com"
        assert config.timeout_seconds == 120

    def test_generate_content_url(self) -> None:
        """Should generate correct content URL."""
        config = GoogleGenAIConfig("test-key")
        url = config.generate_content_url(Model.small())

        assert "generateContent" in url
        assert "test-key" in url
        assert Model.GEMINI_2_0_FLASH in url

    def test_embed_content_url(self) -> None:
        """Should generate correct embed URL."""
        config = GoogleGenAIConfig("test-key")
        url = config.embed_content_url(Model.embedding())

        assert "embedContent" in url
        assert "test-key" in url
        assert Model.TEXT_EMBEDDING_004 in url


class TestTextGenerationParams:
    """Test TextGenerationParams class."""

    def test_basic_creation(self) -> None:
        """Should create params with prompt."""
        params = TextGenerationParams(prompt="Hello")
        assert params.prompt == "Hello"
        assert params.temperature == 0.7

    def test_with_system(self) -> None:
        """Should support system prompt."""
        params = TextGenerationParams(prompt="Hello").with_system("Be concise")
        assert params.system == "Be concise"

    def test_with_max_tokens(self) -> None:
        """Should support max tokens."""
        params = TextGenerationParams(prompt="Hello").with_max_tokens(1024)
        assert params.max_tokens == 1024

    def test_with_temperature(self) -> None:
        """Should support temperature."""
        params = TextGenerationParams(prompt="Hello").with_temperature(0.5)
        assert params.temperature == 0.5


class TestObjectGenerationParams:
    """Test ObjectGenerationParams class."""

    def test_basic_creation(self) -> None:
        """Should create params with prompt."""
        params = ObjectGenerationParams(prompt="Generate JSON")
        assert params.prompt == "Generate JSON"
        assert params.temperature == 0.1  # Lower default for structured output

    def test_with_schema(self) -> None:
        """Should support JSON schema."""
        schema = {"type": "object", "properties": {"name": {"type": "string"}}}
        params = ObjectGenerationParams(prompt="Generate").with_schema(schema)
        assert params.json_schema == schema


class TestEmbeddingParams:
    """Test EmbeddingParams class."""

    def test_basic_creation(self) -> None:
        """Should create params with text."""
        params = EmbeddingParams(text="Hello, world!")
        assert params.text == "Hello, world!"


class TestImageDescriptionParams:
    """Test ImageDescriptionParams class."""

    def test_basic_creation(self) -> None:
        """Should create params with image URL."""
        params = ImageDescriptionParams(image_url="https://example.com/image.jpg")
        assert params.image_url == "https://example.com/image.jpg"
        assert params.prompt is None

    def test_with_prompt(self) -> None:
        """Should support custom prompt."""
        params = ImageDescriptionParams(
            image_url="https://example.com/image.jpg",
            prompt="What objects are in this image?",
        )
        assert params.prompt == "What objects are in this image?"


class TestTokenUsage:
    """Test TokenUsage class."""

    def test_from_api_response(self) -> None:
        """Should parse API response format."""
        usage = TokenUsage(
            promptTokenCount=100,
            candidatesTokenCount=50,
            totalTokenCount=150,
        )
        assert usage.prompt_tokens == 100
        assert usage.completion_tokens == 50
        assert usage.total_tokens == 150


class TestErrors:
    """Test error classes."""

    def test_base_error(self) -> None:
        """Should create base error."""
        error = GoogleGenAIError("Test error")
        assert str(error) == "Test error"
        assert not error.is_retryable()

    def test_api_key_error(self) -> None:
        """Should create API key error."""
        error = ApiKeyError()
        assert "API key" in str(error)
        assert not error.is_retryable()

    def test_config_error(self) -> None:
        """Should create config error."""
        error = ConfigError("Bad config")
        assert "Configuration error" in str(error)
        assert not error.is_retryable()

    def test_json_generation_error(self) -> None:
        """Should create JSON generation error."""
        error = JsonGenerationError("Failed to parse", raw_response="invalid json")
        assert "JSON generation" in str(error)
        assert error.raw_response == "invalid json"

    def test_invalid_parameter_error(self) -> None:
        """Should create invalid parameter error."""
        error = InvalidParameterError("model", "cannot be empty")
        assert "model" in str(error)
        assert error.parameter == "model"





