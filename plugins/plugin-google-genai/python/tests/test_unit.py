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
    def test_plugin_name(self) -> None:
        assert PLUGIN_NAME == "google-genai"

    def test_plugin_description(self) -> None:
        assert PLUGIN_DESCRIPTION
        assert len(PLUGIN_DESCRIPTION) > 0

    def test_plugin_version(self) -> None:
        assert PLUGIN_VERSION
        assert PLUGIN_VERSION == "1.0.0"


class TestModel:
    def test_model_creation(self) -> None:
        model = Model("gemini-2.0-flash-001")
        assert model.id == "gemini-2.0-flash-001"

    def test_model_small(self) -> None:
        model = Model.small()
        assert model.id == Model.GEMINI_2_0_FLASH
        assert model.is_small()
        assert model.size == ModelSize.SMALL

    def test_model_large(self) -> None:
        model = Model.large()
        assert model.id == Model.GEMINI_2_5_PRO
        assert model.is_large()
        assert model.size == ModelSize.LARGE

    def test_model_embedding(self) -> None:
        model = Model.embedding()
        assert model.id == Model.TEXT_EMBEDDING_004
        assert model.is_embedding()
        assert model.size == ModelSize.EMBEDDING

    def test_model_default_max_tokens(self) -> None:
        flash = Model(Model.GEMINI_2_0_FLASH)
        assert flash.default_max_tokens == 8192

        embedding = Model(Model.TEXT_EMBEDDING_004)
        assert embedding.default_max_tokens == 0

    def test_empty_model_id_raises(self) -> None:
        with pytest.raises(InvalidParameterError):
            Model("")
        with pytest.raises(InvalidParameterError):
            Model("   ")

    def test_model_equality(self) -> None:
        model1 = Model("gemini-2.0-flash-001")
        model2 = Model("gemini-2.0-flash-001")
        model3 = Model("gemini-2.5-pro-preview-03-25")

        assert model1 == model2
        assert model1 != model3

    def test_model_string_representation(self) -> None:
        model = Model("gemini-2.0-flash-001")
        assert str(model) == "gemini-2.0-flash-001"


class TestConfig:
    def test_config_creation(self) -> None:
        config = GoogleGenAIConfig("test-api-key")
        assert config.api_key == "test-api-key"
        assert config.base_url == "https://generativelanguage.googleapis.com"

    def test_empty_key_raises(self) -> None:
        with pytest.raises(ApiKeyError):
            GoogleGenAIConfig("")
        with pytest.raises(ApiKeyError):
            GoogleGenAIConfig("   ")

    def test_config_with_custom_models(self) -> None:
        custom_small = Model("custom-small")
        config = GoogleGenAIConfig("test-key", small_model=custom_small)
        assert config.small_model.id == "custom-small"

    def test_config_with_timeout(self) -> None:
        config = GoogleGenAIConfig("test-key", timeout_seconds=120)
        assert config.timeout_seconds == 120

    def test_config_builder_pattern(self) -> None:
        config = (
            GoogleGenAIConfig("test-key").with_base_url("https://custom.api.com").with_timeout(120)
        )

        assert config.base_url == "https://custom.api.com"
        assert config.timeout_seconds == 120

    def test_generate_content_url(self) -> None:
        config = GoogleGenAIConfig("test-key")
        url = config.generate_content_url(Model.small())

        assert "generateContent" in url
        assert "test-key" in url
        assert Model.GEMINI_2_0_FLASH in url

    def test_embed_content_url(self) -> None:
        config = GoogleGenAIConfig("test-key")
        url = config.embed_content_url(Model.embedding())

        assert "embedContent" in url
        assert "test-key" in url
        assert Model.TEXT_EMBEDDING_004 in url


class TestTextGenerationParams:
    def test_basic_creation(self) -> None:
        params = TextGenerationParams(prompt="Hello")
        assert params.prompt == "Hello"
        assert params.temperature == 0.7

    def test_with_system(self) -> None:
        params = TextGenerationParams(prompt="Hello").with_system("Be concise")
        assert params.system == "Be concise"

    def test_with_max_tokens(self) -> None:
        params = TextGenerationParams(prompt="Hello").with_max_tokens(1024)
        assert params.max_tokens == 1024

    def test_with_temperature(self) -> None:
        params = TextGenerationParams(prompt="Hello").with_temperature(0.5)
        assert params.temperature == 0.5


class TestObjectGenerationParams:
    def test_basic_creation(self) -> None:
        params = ObjectGenerationParams(prompt="Generate JSON")
        assert params.prompt == "Generate JSON"
        assert params.temperature == 0.1

    def test_with_schema(self) -> None:
        schema = {"type": "object", "properties": {"name": {"type": "string"}}}
        params = ObjectGenerationParams(prompt="Generate").with_schema(schema)
        assert params.json_schema == schema


class TestEmbeddingParams:
    def test_basic_creation(self) -> None:
        params = EmbeddingParams(text="Hello, world!")
        assert params.text == "Hello, world!"


class TestImageDescriptionParams:
    def test_basic_creation(self) -> None:
        params = ImageDescriptionParams(image_url="https://example.com/image.jpg")
        assert params.image_url == "https://example.com/image.jpg"
        assert params.prompt is None

    def test_with_prompt(self) -> None:
        params = ImageDescriptionParams(
            image_url="https://example.com/image.jpg",
            prompt="What objects are in this image?",
        )
        assert params.prompt == "What objects are in this image?"


class TestTokenUsage:
    def test_from_api_response(self) -> None:
        usage = TokenUsage(
            promptTokenCount=100,
            candidatesTokenCount=50,
            totalTokenCount=150,
        )
        assert usage.prompt_tokens == 100
        assert usage.completion_tokens == 50
        assert usage.total_tokens == 150


class TestErrors:
    def test_base_error(self) -> None:
        error = GoogleGenAIError("Test error")
        assert str(error) == "Test error"
        assert not error.is_retryable()

    def test_api_key_error(self) -> None:
        error = ApiKeyError()
        assert "API key" in str(error)
        assert not error.is_retryable()

    def test_config_error(self) -> None:
        error = ConfigError("Bad config")
        assert "Configuration error" in str(error)
        assert not error.is_retryable()

    def test_json_generation_error(self) -> None:
        error = JsonGenerationError("Failed to parse", raw_response="invalid json")
        assert "JSON generation" in str(error)
        assert error.raw_response == "invalid json"

    def test_invalid_parameter_error(self) -> None:
        error = InvalidParameterError("model", "cannot be empty")
        assert "model" in str(error)
        assert error.parameter == "model"
