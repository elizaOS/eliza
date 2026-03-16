from __future__ import annotations

import os
from pathlib import Path

from elizaos_plugin_local_embedding.errors import ConfigError

DEFAULT_EMBEDDING_MODEL: str = "BAAI/bge-small-en-v1.5"
DEFAULT_EMBEDDING_MODEL_GGUF: str = "bge-small-en-v1.5.Q4_K_M.gguf"
DEFAULT_EMBEDDING_DIMENSIONS: int = 384
DEFAULT_TOKENIZER_NAME: str = "BAAI/bge-small-en-v1.5"


class LocalEmbeddingConfig:
    """Configuration for the local embedding plugin.

    Controls which models are used, where files are stored, and
    expected embedding dimensions. Values can be set explicitly or
    loaded from environment variables via ``from_env()``.
    """

    _embedding_model: str
    _embedding_model_gguf: str
    _models_dir: Path
    _cache_dir: Path
    _embedding_dimensions: int
    _tokenizer_name: str

    def __init__(
        self,
        *,
        embedding_model: str = DEFAULT_EMBEDDING_MODEL,
        embedding_model_gguf: str = DEFAULT_EMBEDDING_MODEL_GGUF,
        models_dir: str | Path | None = None,
        cache_dir: str | Path | None = None,
        embedding_dimensions: int = DEFAULT_EMBEDDING_DIMENSIONS,
        tokenizer_name: str = DEFAULT_TOKENIZER_NAME,
    ) -> None:
        if not embedding_model:
            raise ConfigError("Embedding model name cannot be empty")

        home = Path.home()
        self._embedding_model = embedding_model
        self._embedding_model_gguf = embedding_model_gguf
        self._models_dir = Path(models_dir) if models_dir else home / ".eliza" / "models"
        self._cache_dir = Path(cache_dir) if cache_dir else home / ".eliza" / "cache"
        self._embedding_dimensions = embedding_dimensions
        self._tokenizer_name = tokenizer_name

    @classmethod
    def from_env(cls) -> LocalEmbeddingConfig:
        """Create configuration from environment variables.

        Supported variables:
            - ``LOCAL_EMBEDDING_MODEL`` — embedding model identifier
            - ``LOCAL_EMBEDDING_MODEL_GGUF`` — GGUF model filename
            - ``MODELS_DIR`` — path to models directory
            - ``CACHE_DIR`` — path to cache directory
            - ``LOCAL_EMBEDDING_DIMENSIONS`` — embedding dimensions
            - ``LOCAL_TOKENIZER_NAME`` — HuggingFace tokenizer identifier
        """
        embedding_model = os.environ.get("LOCAL_EMBEDDING_MODEL", DEFAULT_EMBEDDING_MODEL)
        embedding_model_gguf = os.environ.get(
            "LOCAL_EMBEDDING_MODEL_GGUF", DEFAULT_EMBEDDING_MODEL_GGUF
        )
        models_dir = os.environ.get("MODELS_DIR")
        cache_dir = os.environ.get("CACHE_DIR")

        dimensions_str = os.environ.get("LOCAL_EMBEDDING_DIMENSIONS")
        embedding_dimensions = (
            int(dimensions_str) if dimensions_str else DEFAULT_EMBEDDING_DIMENSIONS
        )

        tokenizer_name = os.environ.get("LOCAL_TOKENIZER_NAME", DEFAULT_TOKENIZER_NAME)

        return cls(
            embedding_model=embedding_model,
            embedding_model_gguf=embedding_model_gguf,
            models_dir=models_dir,
            cache_dir=cache_dir,
            embedding_dimensions=embedding_dimensions,
            tokenizer_name=tokenizer_name,
        )

    # ---- Properties ----

    @property
    def embedding_model(self) -> str:
        """The embedding model identifier (e.g. ``BAAI/bge-small-en-v1.5``)."""
        return self._embedding_model

    @property
    def embedding_model_gguf(self) -> str:
        """The GGUF model filename for HuggingFace downloads."""
        return self._embedding_model_gguf

    @property
    def models_dir(self) -> Path:
        """Path to the models directory."""
        return self._models_dir

    @property
    def cache_dir(self) -> Path:
        """Path to the cache directory."""
        return self._cache_dir

    @property
    def embedding_dimensions(self) -> int:
        """Expected embedding vector dimensionality."""
        return self._embedding_dimensions

    @property
    def tokenizer_name(self) -> str:
        """HuggingFace tokenizer identifier."""
        return self._tokenizer_name

    # ---- Builder methods (return new config instances) ----

    def with_embedding_model(self, model: str) -> LocalEmbeddingConfig:
        """Return a copy with a different embedding model."""
        return LocalEmbeddingConfig(
            embedding_model=model,
            embedding_model_gguf=self._embedding_model_gguf,
            models_dir=self._models_dir,
            cache_dir=self._cache_dir,
            embedding_dimensions=self._embedding_dimensions,
            tokenizer_name=self._tokenizer_name,
        )

    def with_embedding_dimensions(self, dimensions: int) -> LocalEmbeddingConfig:
        """Return a copy with different embedding dimensions."""
        return LocalEmbeddingConfig(
            embedding_model=self._embedding_model,
            embedding_model_gguf=self._embedding_model_gguf,
            models_dir=self._models_dir,
            cache_dir=self._cache_dir,
            embedding_dimensions=dimensions,
            tokenizer_name=self._tokenizer_name,
        )

    def with_cache_dir(self, cache_dir: str | Path) -> LocalEmbeddingConfig:
        """Return a copy with a different cache directory."""
        return LocalEmbeddingConfig(
            embedding_model=self._embedding_model,
            embedding_model_gguf=self._embedding_model_gguf,
            models_dir=self._models_dir,
            cache_dir=cache_dir,
            embedding_dimensions=self._embedding_dimensions,
            tokenizer_name=self._tokenizer_name,
        )

    def with_tokenizer_name(self, name: str) -> LocalEmbeddingConfig:
        """Return a copy with a different tokenizer."""
        return LocalEmbeddingConfig(
            embedding_model=self._embedding_model,
            embedding_model_gguf=self._embedding_model_gguf,
            models_dir=self._models_dir,
            cache_dir=self._cache_dir,
            embedding_dimensions=self._embedding_dimensions,
            tokenizer_name=name,
        )
