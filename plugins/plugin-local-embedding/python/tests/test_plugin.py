from __future__ import annotations

import math
from pathlib import Path

import pytest

from elizaos_plugin_local_embedding.config import (
    DEFAULT_EMBEDDING_DIMENSIONS,
    DEFAULT_EMBEDDING_MODEL,
    DEFAULT_EMBEDDING_MODEL_GGUF,
    DEFAULT_TOKENIZER_NAME,
    LocalEmbeddingConfig,
)
from elizaos_plugin_local_embedding.errors import ConfigError
from elizaos_plugin_local_embedding.plugin import (
    PLUGIN_NAME,
    PLUGIN_VERSION,
    LocalEmbeddingManager,
    plugin,
)
from elizaos_plugin_local_embedding.types import (
    EmbeddingModelSpec,
    EmbeddingParams,
    EmbeddingResponse,
    ModelSpec,
    ModelSpecs,
    TokenDecodeParams,
    TokenDecodeResponse,
    TokenEncodeParams,
    TokenEncodeResponse,
    TokenizerConfig,
)


# ================================================================
# Config tests
# ================================================================


class TestConfig:
    def test_config_defaults(self) -> None:
        config = LocalEmbeddingConfig()
        assert config.embedding_model == DEFAULT_EMBEDDING_MODEL
        assert config.embedding_dimensions == DEFAULT_EMBEDDING_DIMENSIONS
        assert config.tokenizer_name == DEFAULT_TOKENIZER_NAME
        assert config.embedding_model_gguf == DEFAULT_EMBEDDING_MODEL_GGUF

    def test_config_from_env(self) -> None:
        config = LocalEmbeddingConfig.from_env()
        assert config.embedding_model == DEFAULT_EMBEDDING_MODEL
        assert config.embedding_dimensions == DEFAULT_EMBEDDING_DIMENSIONS

    def test_config_custom(self) -> None:
        config = LocalEmbeddingConfig(
            embedding_model="custom/model",
            embedding_dimensions=768,
            tokenizer_name="custom/tokenizer",
            models_dir="/tmp/models",
            cache_dir="/tmp/cache",
        )
        assert config.embedding_model == "custom/model"
        assert config.embedding_dimensions == 768
        assert config.tokenizer_name == "custom/tokenizer"
        assert config.models_dir == Path("/tmp/models")
        assert config.cache_dir == Path("/tmp/cache")

    def test_config_empty_model_raises(self) -> None:
        with pytest.raises(ConfigError):
            LocalEmbeddingConfig(embedding_model="")

    def test_config_builder_with_embedding_model(self) -> None:
        config = LocalEmbeddingConfig().with_embedding_model("new/model")
        assert config.embedding_model == "new/model"
        # Other fields retain defaults
        assert config.embedding_dimensions == DEFAULT_EMBEDDING_DIMENSIONS

    def test_config_builder_with_dimensions(self) -> None:
        config = LocalEmbeddingConfig().with_embedding_dimensions(1024)
        assert config.embedding_dimensions == 1024
        assert config.embedding_model == DEFAULT_EMBEDDING_MODEL

    def test_config_builder_with_cache_dir(self) -> None:
        config = LocalEmbeddingConfig().with_cache_dir("/custom/cache")
        assert config.cache_dir == Path("/custom/cache")

    def test_config_builder_with_tokenizer(self) -> None:
        config = LocalEmbeddingConfig().with_tokenizer_name("custom/tok")
        assert config.tokenizer_name == "custom/tok"

    def test_config_default_paths(self) -> None:
        config = LocalEmbeddingConfig()
        assert config.models_dir == Path.home() / ".eliza" / "models"
        assert config.cache_dir == Path.home() / ".eliza" / "cache"


# ================================================================
# Type tests
# ================================================================


class TestTypes:
    def test_embedding_model_spec(self) -> None:
        spec = ModelSpecs.embedding()
        assert spec.dimensions == 384
        assert spec.context_size == 512
        assert spec.tokenizer.tokenizer_type == "bert"
        assert spec.tokenizer.name == "BAAI/bge-small-en-v1.5"
        assert spec.repo == "ChristianAzinn/bge-small-en-v1.5-gguf"

    def test_small_model_spec(self) -> None:
        spec = ModelSpecs.small()
        assert spec.context_size == 8192
        assert spec.quantization == "Q4_0"
        assert spec.size == "3B"
        assert spec.tokenizer.tokenizer_type == "llama"

    def test_medium_model_spec(self) -> None:
        spec = ModelSpecs.medium()
        assert spec.size == "8B"
        assert spec.context_size == 8192

    def test_embedding_params(self) -> None:
        params = EmbeddingParams(text="hello world")
        assert params.text == "hello world"

    def test_embedding_response(self) -> None:
        response = EmbeddingResponse(embedding=[0.1, 0.2, 0.3], dimensions=3)
        assert len(response.embedding) == 3
        assert response.dimensions == 3

    def test_token_encode_params(self) -> None:
        params = TokenEncodeParams(text="test")
        assert params.text == "test"

    def test_token_encode_response(self) -> None:
        response = TokenEncodeResponse(tokens=[1, 2, 3])
        assert response.tokens == [1, 2, 3]

    def test_token_decode_params(self) -> None:
        params = TokenDecodeParams(tokens=[1, 2, 3])
        assert params.tokens == [1, 2, 3]

    def test_token_decode_response(self) -> None:
        response = TokenDecodeResponse(text="hello")
        assert response.text == "hello"

    def test_tokenizer_config(self) -> None:
        config = TokenizerConfig(name="test", tokenizer_type="bert")
        assert config.name == "test"
        assert config.tokenizer_type == "bert"

    def test_model_spec_serialization(self) -> None:
        spec = ModelSpecs.embedding()
        json_str = spec.model_dump_json()
        deserialized = EmbeddingModelSpec.model_validate_json(json_str)
        assert deserialized.dimensions == spec.dimensions
        assert deserialized.context_size == spec.context_size
        assert deserialized.tokenizer.name == spec.tokenizer.name

    def test_small_model_spec_serialization(self) -> None:
        spec = ModelSpecs.small()
        json_str = spec.model_dump_json()
        deserialized = ModelSpec.model_validate_json(json_str)
        assert deserialized.name == spec.name
        assert deserialized.context_size == spec.context_size


# ================================================================
# Plugin structure tests
# ================================================================


class TestPluginStructure:
    def test_plugin_name(self) -> None:
        assert PLUGIN_NAME == "local-embedding"

    def test_plugin_version(self) -> None:
        assert PLUGIN_VERSION == "2.0.0"

    def test_plugin_dict_has_required_keys(self) -> None:
        assert "name" in plugin
        assert "description" in plugin
        assert "models" in plugin
        assert "version" in plugin

    def test_plugin_has_model_handlers(self) -> None:
        models = plugin["models"]
        assert isinstance(models, dict)
        assert "TEXT_EMBEDDING" in models
        assert "TEXT_TOKENIZER_ENCODE" in models
        assert "TEXT_TOKENIZER_DECODE" in models

    def test_model_handlers_are_callable(self) -> None:
        models = plugin["models"]
        assert isinstance(models, dict)
        assert callable(models["TEXT_EMBEDDING"])
        assert callable(models["TEXT_TOKENIZER_ENCODE"])
        assert callable(models["TEXT_TOKENIZER_DECODE"])

    def test_plugin_name_matches_constant(self) -> None:
        assert plugin["name"] == PLUGIN_NAME


# ================================================================
# Normalization tests (no model download needed)
# ================================================================


class TestNormalization:
    def test_normalize_unit_vector(self) -> None:
        embedding = [3.0, 4.0]
        normalized = LocalEmbeddingManager._normalize_embedding(embedding)
        assert abs(normalized[0] - 0.6) < 1e-6
        assert abs(normalized[1] - 0.8) < 1e-6

        l2 = math.sqrt(sum(v * v for v in normalized))
        assert abs(l2 - 1.0) < 1e-6

    def test_normalize_zero_vector(self) -> None:
        embedding = [0.0, 0.0, 0.0]
        normalized = LocalEmbeddingManager._normalize_embedding(embedding)
        assert all(v == 0.0 for v in normalized)

    def test_normalize_single_dimension(self) -> None:
        embedding = [5.0]
        normalized = LocalEmbeddingManager._normalize_embedding(embedding)
        assert abs(normalized[0] - 1.0) < 1e-6

    def test_normalize_preserves_direction(self) -> None:
        embedding = [1.0, 2.0, 3.0]
        normalized = LocalEmbeddingManager._normalize_embedding(embedding)
        ratio_01 = normalized[1] / normalized[0]
        assert abs(ratio_01 - 2.0) < 1e-6
        ratio_02 = normalized[2] / normalized[0]
        assert abs(ratio_02 - 3.0) < 1e-6

    def test_normalize_negative_values(self) -> None:
        embedding = [-3.0, 4.0]
        normalized = LocalEmbeddingManager._normalize_embedding(embedding)
        assert abs(normalized[0] - (-0.6)) < 1e-6
        assert abs(normalized[1] - 0.8) < 1e-6
