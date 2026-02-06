from __future__ import annotations

import logging
import math

from fastembed import TextEmbedding
from tokenizers import Tokenizer

from elizaos_plugin_local_embedding.config import LocalEmbeddingConfig
from elizaos_plugin_local_embedding.errors import (
    EmbeddingError,
    ModelLoadError,
    TokenizationError,
)
from elizaos_plugin_local_embedding.types import (
    EmbeddingParams,
    EmbeddingResponse,
    TokenDecodeParams,
    TokenDecodeResponse,
    TokenEncodeParams,
    TokenEncodeResponse,
)

logger = logging.getLogger(__name__)

PLUGIN_NAME: str = "local-embedding"
PLUGIN_DESCRIPTION: str = (
    "Local text embedding and tokenization using ONNX models and HuggingFace tokenizers"
)
PLUGIN_VERSION: str = "2.0.0"


class LocalEmbeddingManager:
    """Manager for local embedding generation and tokenization.

    Wraps a fastembed ``TextEmbedding`` model for embedding generation and a
    HuggingFace ``Tokenizer`` for text encoding/decoding. Model files are
    downloaded automatically on first use if not already cached.
    """

    _config: LocalEmbeddingConfig
    _embedding_model: TextEmbedding
    _tokenizer: Tokenizer

    def __init__(self, config: LocalEmbeddingConfig) -> None:
        logger.info("Initializing local embedding manager")

        self._config = config
        self._embedding_model = self._load_embedding_model(config)
        self._tokenizer = self._load_tokenizer(config)

        logger.info("Local embedding manager initialized successfully")

    @property
    def config(self) -> LocalEmbeddingConfig:
        """Access the underlying configuration."""
        return self._config

    def generate_embedding(self, params: EmbeddingParams) -> EmbeddingResponse:
        """Generate an embedding vector for the given text.

        Returns a zero vector when ``params.text`` is empty.
        """
        if not params.text:
            logger.debug("Empty text input, returning zero vector")
            return EmbeddingResponse(
                embedding=[0.0] * self._config.embedding_dimensions,
                dimensions=self._config.embedding_dimensions,
            )

        logger.info("Generating embedding for text of length %d", len(params.text))

        try:
            embeddings = list(self._embedding_model.embed([params.text]))
        except Exception as e:
            raise EmbeddingError(f"Embedding generation failed: {e}") from e

        if not embeddings:
            raise EmbeddingError("No embedding returned from model")

        raw_embedding = embeddings[0]
        # Convert numpy array or other array-like to plain Python list
        embedding_list: list[float] = (
            raw_embedding.tolist()
            if hasattr(raw_embedding, "tolist")
            else list(raw_embedding)
        )

        normalized = self._normalize_embedding(embedding_list)
        dimensions = len(normalized)

        logger.info("Embedding generated with %d dimensions", dimensions)

        return EmbeddingResponse(embedding=normalized, dimensions=dimensions)

    def encode_text(self, params: TokenEncodeParams) -> TokenEncodeResponse:
        """Encode text into a sequence of token IDs."""
        logger.info("Encoding text of length %d", len(params.text))

        try:
            encoding = self._tokenizer.encode(params.text)
        except Exception as e:
            raise TokenizationError(f"Encoding failed: {e}") from e

        tokens: list[int] = list(encoding.ids)
        logger.info("Text encoded to %d tokens", len(tokens))

        return TokenEncodeResponse(tokens=tokens)

    def decode_tokens(self, params: TokenDecodeParams) -> TokenDecodeResponse:
        """Decode a sequence of token IDs back into text."""
        logger.info("Decoding %d tokens", len(params.tokens))

        try:
            text: str = self._tokenizer.decode(params.tokens, skip_special_tokens=True)
        except Exception as e:
            raise TokenizationError(f"Decoding failed: {e}") from e

        logger.info("Tokens decoded to text of length %d", len(text))

        return TokenDecodeResponse(text=text)

    # ---- Private helpers ----

    @staticmethod
    def _load_embedding_model(config: LocalEmbeddingConfig) -> TextEmbedding:
        logger.info("Loading embedding model: %s", config.embedding_model)
        try:
            return TextEmbedding(model_name=config.embedding_model)
        except Exception as e:
            raise ModelLoadError(config.embedding_model, str(e)) from e

    @staticmethod
    def _load_tokenizer(config: LocalEmbeddingConfig) -> Tokenizer:
        logger.info("Loading tokenizer: %s", config.tokenizer_name)
        try:
            return Tokenizer.from_pretrained(config.tokenizer_name)
        except Exception as e:
            raise TokenizationError(f"Failed to load tokenizer: {e}") from e

    @staticmethod
    def _normalize_embedding(embedding: list[float]) -> list[float]:
        """L2 (Euclidean) normalization of an embedding vector."""
        square_sum = sum(v * v for v in embedding)
        norm = math.sqrt(square_sum)

        if norm == 0.0:
            return embedding

        return [v / norm for v in embedding]


# ---- Module-level singleton and model handlers ----

_manager: LocalEmbeddingManager | None = None


def get_manager() -> LocalEmbeddingManager:
    """Get or create the singleton :class:`LocalEmbeddingManager`."""
    global _manager  # noqa: PLW0603
    if _manager is None:
        config = LocalEmbeddingConfig.from_env()
        _manager = LocalEmbeddingManager(config)
    return _manager


async def handle_text_embedding(
    runtime: object,
    params: EmbeddingParams | str | None,
) -> list[float]:
    """Model handler for TEXT_EMBEDDING.

    Accepts a string, an :class:`EmbeddingParams` object, or ``None``.
    Returns the embedding vector as a list of floats.
    """
    manager = get_manager()

    if params is None:
        return [0.0] * manager.config.embedding_dimensions

    if isinstance(params, str):
        params = EmbeddingParams(text=params)

    response = manager.generate_embedding(params)
    return response.embedding


async def handle_text_tokenizer_encode(
    runtime: object,
    params: TokenEncodeParams,
) -> list[int]:
    """Model handler for TEXT_TOKENIZER_ENCODE.

    Returns a list of token IDs.
    """
    manager = get_manager()
    response = manager.encode_text(params)
    return response.tokens


async def handle_text_tokenizer_decode(
    runtime: object,
    params: TokenDecodeParams,
) -> str:
    """Model handler for TEXT_TOKENIZER_DECODE.

    Returns the decoded text.
    """
    manager = get_manager()
    response = manager.decode_tokens(params)
    return response.text


# Plugin definition dictionary — matches the TypeScript plugin structure.
plugin: dict[str, object] = {
    "name": PLUGIN_NAME,
    "description": PLUGIN_DESCRIPTION,
    "version": PLUGIN_VERSION,
    "models": {
        "TEXT_EMBEDDING": handle_text_embedding,
        "TEXT_TOKENIZER_ENCODE": handle_text_tokenizer_encode,
        "TEXT_TOKENIZER_DECODE": handle_text_tokenizer_decode,
    },
}
