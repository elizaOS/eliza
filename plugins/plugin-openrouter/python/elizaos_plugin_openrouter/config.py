"""
Configuration for the OpenRouter client.

Configuration is loaded from environment variables or provided explicitly.
"""

from __future__ import annotations

import os

from elizaos_plugin_openrouter.errors import ApiKeyError

# Default values
DEFAULT_BASE_URL: str = "https://openrouter.ai/api/v1"
DEFAULT_SMALL_MODEL: str = "google/gemini-2.0-flash-001"
DEFAULT_LARGE_MODEL: str = "google/gemini-2.5-flash"
DEFAULT_IMAGE_MODEL: str = "x-ai/grok-2-vision-1212"
DEFAULT_EMBEDDING_MODEL: str = "openai/text-embedding-3-small"
DEFAULT_EMBEDDING_DIMENSIONS: int = 1536
DEFAULT_TIMEOUT_SECONDS: int = 60


class OpenRouterConfig:
    """Configuration for the OpenRouter client."""

    _api_key: str
    _base_url: str
    _small_model: str
    _large_model: str
    _image_model: str
    _embedding_model: str
    _embedding_dimensions: int
    _timeout_seconds: int

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = DEFAULT_BASE_URL,
        small_model: str = DEFAULT_SMALL_MODEL,
        large_model: str = DEFAULT_LARGE_MODEL,
        image_model: str = DEFAULT_IMAGE_MODEL,
        embedding_model: str = DEFAULT_EMBEDDING_MODEL,
        embedding_dimensions: int = DEFAULT_EMBEDDING_DIMENSIONS,
        timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        """
        Create a new configuration with an API key.

        Args:
            api_key: The OpenRouter API key (required).
            base_url: Base URL for the API.
            small_model: Model to use for small text generation.
            large_model: Model to use for large text generation.
            image_model: Model to use for image description.
            embedding_model: Model to use for embeddings.
            embedding_dimensions: Dimensions for embeddings.
            timeout_seconds: Request timeout in seconds.

        Raises:
            ApiKeyError: If the API key is empty.
        """
        if not api_key or not api_key.strip():
            raise ApiKeyError("API key cannot be empty")

        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._small_model = small_model
        self._large_model = large_model
        self._image_model = image_model
        self._embedding_model = embedding_model
        self._embedding_dimensions = embedding_dimensions
        self._timeout_seconds = timeout_seconds

    @classmethod
    def from_env(cls) -> OpenRouterConfig:
        """
        Load configuration from environment variables.

        Required:
            OPENROUTER_API_KEY

        Optional:
            OPENROUTER_BASE_URL
            OPENROUTER_SMALL_MODEL or SMALL_MODEL
            OPENROUTER_LARGE_MODEL or LARGE_MODEL
            OPENROUTER_IMAGE_MODEL or IMAGE_MODEL
            OPENROUTER_EMBEDDING_MODEL or EMBEDDING_MODEL
            OPENROUTER_EMBEDDING_DIMENSIONS or EMBEDDING_DIMENSIONS
            OPENROUTER_TIMEOUT_SECONDS

        Returns:
            Configured OpenRouterConfig instance.

        Raises:
            ApiKeyError: If OPENROUTER_API_KEY is not set or is empty.
        """
        api_key = os.environ.get("OPENROUTER_API_KEY", "")
        if not api_key:
            raise ApiKeyError()

        base_url = os.environ.get("OPENROUTER_BASE_URL", DEFAULT_BASE_URL)

        small_model = (
            os.environ.get("OPENROUTER_SMALL_MODEL")
            or os.environ.get("SMALL_MODEL")
            or DEFAULT_SMALL_MODEL
        )

        large_model = (
            os.environ.get("OPENROUTER_LARGE_MODEL")
            or os.environ.get("LARGE_MODEL")
            or DEFAULT_LARGE_MODEL
        )

        image_model = (
            os.environ.get("OPENROUTER_IMAGE_MODEL")
            or os.environ.get("IMAGE_MODEL")
            or DEFAULT_IMAGE_MODEL
        )

        embedding_model = (
            os.environ.get("OPENROUTER_EMBEDDING_MODEL")
            or os.environ.get("EMBEDDING_MODEL")
            or DEFAULT_EMBEDDING_MODEL
        )

        embedding_dim_str = os.environ.get("OPENROUTER_EMBEDDING_DIMENSIONS") or os.environ.get(
            "EMBEDDING_DIMENSIONS"
        )
        embedding_dimensions = (
            int(embedding_dim_str) if embedding_dim_str else DEFAULT_EMBEDDING_DIMENSIONS
        )

        timeout_str = os.environ.get("OPENROUTER_TIMEOUT_SECONDS")
        timeout_seconds = int(timeout_str) if timeout_str else DEFAULT_TIMEOUT_SECONDS

        return cls(
            api_key=api_key,
            base_url=base_url,
            small_model=small_model,
            large_model=large_model,
            image_model=image_model,
            embedding_model=embedding_model,
            embedding_dimensions=embedding_dimensions,
            timeout_seconds=timeout_seconds,
        )

    @property
    def api_key(self) -> str:
        """Get the API key."""
        return self._api_key

    @property
    def base_url(self) -> str:
        """Get the base URL."""
        return self._base_url

    @property
    def small_model(self) -> str:
        """Get the small model name."""
        return self._small_model

    @property
    def large_model(self) -> str:
        """Get the large model name."""
        return self._large_model

    @property
    def image_model(self) -> str:
        """Get the image model name."""
        return self._image_model

    @property
    def embedding_model(self) -> str:
        """Get the embedding model name."""
        return self._embedding_model

    @property
    def embedding_dimensions(self) -> int:
        """Get the embedding dimensions."""
        return self._embedding_dimensions

    @property
    def timeout_seconds(self) -> int:
        """Get the timeout in seconds."""
        return self._timeout_seconds

    @property
    def chat_completions_url(self) -> str:
        """Get the full chat completions endpoint URL."""
        return f"{self._base_url}/chat/completions"

    @property
    def embeddings_url(self) -> str:
        """Get the full embeddings endpoint URL."""
        return f"{self._base_url}/embeddings"

    @property
    def models_url(self) -> str:
        """Get the full models endpoint URL."""
        return f"{self._base_url}/models"

    def with_base_url(self, base_url: str) -> OpenRouterConfig:
        """Create a new config with a different base URL."""
        return OpenRouterConfig(
            api_key=self._api_key,
            base_url=base_url,
            small_model=self._small_model,
            large_model=self._large_model,
            image_model=self._image_model,
            embedding_model=self._embedding_model,
            embedding_dimensions=self._embedding_dimensions,
            timeout_seconds=self._timeout_seconds,
        )

    def with_timeout(self, seconds: int) -> OpenRouterConfig:
        """Create a new config with a different timeout."""
        return OpenRouterConfig(
            api_key=self._api_key,
            base_url=self._base_url,
            small_model=self._small_model,
            large_model=self._large_model,
            image_model=self._image_model,
            embedding_model=self._embedding_model,
            embedding_dimensions=self._embedding_dimensions,
            timeout_seconds=seconds,
        )





