from __future__ import annotations

import math
import os

import pytest

from elizaos_plugin_local_embedding.config import LocalEmbeddingConfig
from elizaos_plugin_local_embedding.plugin import LocalEmbeddingManager
from elizaos_plugin_local_embedding.types import (
    EmbeddingParams,
    TokenDecodeParams,
    TokenEncodeParams,
)


@pytest.fixture
def config() -> LocalEmbeddingConfig:
    return LocalEmbeddingConfig.from_env()


@pytest.fixture
def manager(config: LocalEmbeddingConfig) -> LocalEmbeddingManager:
    return LocalEmbeddingManager(config)


# ================================================================
# Embedding generation tests (require model download)
#
# Enable with: LOCAL_EMBEDDING_INTEGRATION_TESTS=1 pytest
# ================================================================


@pytest.mark.skipif(
    os.environ.get("LOCAL_EMBEDDING_INTEGRATION_TESTS") != "1",
    reason="Integration tests disabled. Set LOCAL_EMBEDDING_INTEGRATION_TESTS=1 to enable.",
)
class TestEmbeddingGeneration:
    def test_generate_embedding(self, manager: LocalEmbeddingManager) -> None:
        params = EmbeddingParams(text="This is a test sentence for embedding.")
        response = manager.generate_embedding(params)

        assert len(response.embedding) > 0
        assert response.dimensions == len(response.embedding)
        assert all(isinstance(v, float) for v in response.embedding)

    def test_embedding_is_normalized(self, manager: LocalEmbeddingManager) -> None:
        params = EmbeddingParams(text="Testing L2 normalization of embeddings.")
        response = manager.generate_embedding(params)

        l2 = math.sqrt(sum(v * v for v in response.embedding))
        assert abs(l2 - 1.0) < 0.01, f"L2 norm should be ~1.0, got {l2}"

    def test_empty_text_returns_zero_vector(
        self, manager: LocalEmbeddingManager
    ) -> None:
        params = EmbeddingParams(text="")
        response = manager.generate_embedding(params)

        assert response.dimensions == 384
        assert all(v == 0.0 for v in response.embedding)

    def test_different_texts_different_embeddings(
        self, manager: LocalEmbeddingManager
    ) -> None:
        response_a = manager.generate_embedding(
            EmbeddingParams(text="Cats are wonderful pets.")
        )
        response_b = manager.generate_embedding(
            EmbeddingParams(text="Quantum physics is fascinating.")
        )

        assert response_a.embedding != response_b.embedding

    def test_similar_texts_similar_embeddings(
        self, manager: LocalEmbeddingManager
    ) -> None:
        response_a = manager.generate_embedding(
            EmbeddingParams(text="The cat sat on the mat.")
        )
        response_b = manager.generate_embedding(
            EmbeddingParams(text="A cat was sitting on a mat.")
        )

        # Cosine similarity should be high for similar texts
        dot_product = sum(
            a * b for a, b in zip(response_a.embedding, response_b.embedding)
        )
        assert dot_product > 0.8, f"Cosine similarity should be > 0.8, got {dot_product}"


# ================================================================
# Tokenization tests (require tokenizer download)
# ================================================================


@pytest.mark.skipif(
    os.environ.get("LOCAL_EMBEDDING_INTEGRATION_TESTS") != "1",
    reason="Integration tests disabled. Set LOCAL_EMBEDDING_INTEGRATION_TESTS=1 to enable.",
)
class TestTokenization:
    def test_encode_text(self, manager: LocalEmbeddingManager) -> None:
        params = TokenEncodeParams(text="Hello, world!")
        response = manager.encode_text(params)

        assert len(response.tokens) > 0
        assert all(isinstance(t, int) for t in response.tokens)

    def test_decode_tokens(self, manager: LocalEmbeddingManager) -> None:
        encode_response = manager.encode_text(TokenEncodeParams(text="Hello, world!"))
        decode_response = manager.decode_tokens(
            TokenDecodeParams(tokens=encode_response.tokens)
        )

        assert len(decode_response.text) > 0

    def test_encode_decode_roundtrip(self, manager: LocalEmbeddingManager) -> None:
        original = "The quick brown fox jumps over the lazy dog."

        encode_response = manager.encode_text(TokenEncodeParams(text=original))
        assert len(encode_response.tokens) > 0

        decode_response = manager.decode_tokens(
            TokenDecodeParams(tokens=encode_response.tokens)
        )

        # Key words should survive the round-trip
        assert "quick" in decode_response.text
        assert "fox" in decode_response.text

    def test_encode_produces_integer_tokens(
        self, manager: LocalEmbeddingManager
    ) -> None:
        params = TokenEncodeParams(text="Testing integer token output")
        response = manager.encode_text(params)

        for token in response.tokens:
            assert isinstance(token, int)
            assert token >= 0

    def test_encode_empty_text(self, manager: LocalEmbeddingManager) -> None:
        params = TokenEncodeParams(text="")
        response = manager.encode_text(params)
        # Even empty text may produce special tokens, but it shouldn't error
        assert isinstance(response.tokens, list)


# ================================================================
# Config tests that always run
# ================================================================


class TestConfigIntegration:
    def test_config_defaults(self) -> None:
        config = LocalEmbeddingConfig()
        assert config.embedding_model == "BAAI/bge-small-en-v1.5"
        assert config.embedding_dimensions == 384
        assert config.tokenizer_name == "BAAI/bge-small-en-v1.5"

    def test_config_custom(self) -> None:
        config = LocalEmbeddingConfig(
            embedding_model="custom/model",
            embedding_dimensions=768,
        )
        assert config.embedding_model == "custom/model"
        assert config.embedding_dimensions == 768
