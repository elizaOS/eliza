from __future__ import annotations


class LocalEmbeddingError(Exception):
    """Base error for the local embedding plugin."""


class ConfigError(LocalEmbeddingError):
    """Configuration-related error."""


class ModelLoadError(LocalEmbeddingError):
    """Failed to load or initialize a model."""

    def __init__(self, model: str, message: str | None = None) -> None:
        self.model = model
        msg = f"Failed to load model '{model}'"
        if message:
            msg = f"{msg}: {message}"
        super().__init__(msg)


class EmbeddingError(LocalEmbeddingError):
    """Error during embedding generation."""


class TokenizationError(LocalEmbeddingError):
    """Error during tokenization (encode or decode)."""
