"""
Configuration for the Google GenAI client.

Configuration is loaded from environment variables or provided explicitly.
All required values must be present - no defaults for secrets.
"""

from __future__ import annotations

import os

from elizaos_plugin_google_genai.errors import ApiKeyError
from elizaos_plugin_google_genai.models import Model

# Default values
DEFAULT_BASE_URL: str = "https://generativelanguage.googleapis.com"
DEFAULT_API_VERSION: str = "v1beta"
DEFAULT_TIMEOUT_SECONDS: int = 60


class GoogleGenAIConfig:
    """Configuration for the Google GenAI client."""

    _api_key: str
    _base_url: str
    _api_version: str
    _small_model: Model
    _large_model: Model
    _embedding_model: Model
    _image_model: Model
    _timeout_seconds: int

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = DEFAULT_BASE_URL,
        api_version: str = DEFAULT_API_VERSION,
        small_model: Model | None = None,
        large_model: Model | None = None,
        embedding_model: Model | None = None,
        image_model: Model | None = None,
        timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        """
        Create a new configuration with an API key.

        Args:
            api_key: The Google AI API key (required).
            base_url: Base URL for the API.
            api_version: API version string.
            small_model: Model to use for small text generation.
            large_model: Model to use for large text generation.
            embedding_model: Model to use for embeddings.
            image_model: Model to use for image analysis.
            timeout_seconds: Request timeout in seconds.

        Raises:
            ApiKeyError: If the API key is empty.
        """
        if not api_key or not api_key.strip():
            raise ApiKeyError("API key cannot be empty")

        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._api_version = api_version
        self._small_model = small_model or Model.small()
        self._large_model = large_model or Model.large()
        self._embedding_model = embedding_model or Model.embedding()
        self._image_model = image_model or Model.large()
        self._timeout_seconds = timeout_seconds

    @classmethod
    def from_env(cls) -> GoogleGenAIConfig:
        """
        Load configuration from environment variables.

        Required:
            GOOGLE_GENERATIVE_AI_API_KEY

        Optional:
            GOOGLE_BASE_URL (default: https://generativelanguage.googleapis.com)
            GOOGLE_SMALL_MODEL (default: gemini-2.0-flash-001)
            GOOGLE_LARGE_MODEL (default: gemini-2.5-pro-preview-03-25)
            GOOGLE_EMBEDDING_MODEL (default: text-embedding-004)
            GOOGLE_IMAGE_MODEL (default: gemini-2.5-pro-preview-03-25)
            GOOGLE_TIMEOUT_SECONDS (default: 60)

        Returns:
            Configured GoogleGenAIConfig instance.

        Raises:
            ApiKeyError: If GOOGLE_GENERATIVE_AI_API_KEY is not set or is empty.
        """
        api_key = os.environ.get("GOOGLE_GENERATIVE_AI_API_KEY", "")
        if not api_key:
            raise ApiKeyError(
                "GOOGLE_GENERATIVE_AI_API_KEY environment variable is not set. "
                "Please set it to your Google AI API key."
            )

        base_url = os.environ.get("GOOGLE_BASE_URL", DEFAULT_BASE_URL)

        small_model_id = os.environ.get("GOOGLE_SMALL_MODEL")
        small_model = Model(small_model_id) if small_model_id else None

        large_model_id = os.environ.get("GOOGLE_LARGE_MODEL")
        large_model = Model(large_model_id) if large_model_id else None

        embedding_model_id = os.environ.get("GOOGLE_EMBEDDING_MODEL")
        embedding_model = Model(embedding_model_id) if embedding_model_id else None

        image_model_id = os.environ.get("GOOGLE_IMAGE_MODEL")
        image_model = Model(image_model_id) if image_model_id else None

        timeout_str = os.environ.get("GOOGLE_TIMEOUT_SECONDS")
        timeout_seconds = int(timeout_str) if timeout_str else DEFAULT_TIMEOUT_SECONDS

        return cls(
            api_key=api_key,
            base_url=base_url,
            small_model=small_model,
            large_model=large_model,
            embedding_model=embedding_model,
            image_model=image_model,
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
    def api_version(self) -> str:
        """Get the API version."""
        return self._api_version

    @property
    def small_model(self) -> Model:
        """Get the small model."""
        return self._small_model

    @property
    def large_model(self) -> Model:
        """Get the large model."""
        return self._large_model

    @property
    def embedding_model(self) -> Model:
        """Get the embedding model."""
        return self._embedding_model

    @property
    def image_model(self) -> Model:
        """Get the image model."""
        return self._image_model

    @property
    def timeout_seconds(self) -> int:
        """Get the timeout in seconds."""
        return self._timeout_seconds

    def generate_content_url(self, model: Model) -> str:
        """Get the full generateContent endpoint URL for a model."""
        return f"{self._base_url}/{self._api_version}/models/{model.id}:generateContent?key={self._api_key}"

    def embed_content_url(self, model: Model) -> str:
        """Get the full embedContent endpoint URL for a model."""
        return f"{self._base_url}/{self._api_version}/models/{model.id}:embedContent?key={self._api_key}"

    def with_base_url(self, base_url: str) -> GoogleGenAIConfig:
        """Create a new config with a different base URL."""
        return GoogleGenAIConfig(
            api_key=self._api_key,
            base_url=base_url,
            api_version=self._api_version,
            small_model=self._small_model,
            large_model=self._large_model,
            embedding_model=self._embedding_model,
            image_model=self._image_model,
            timeout_seconds=self._timeout_seconds,
        )

    def with_timeout(self, seconds: int) -> GoogleGenAIConfig:
        """Create a new config with a different timeout."""
        return GoogleGenAIConfig(
            api_key=self._api_key,
            base_url=self._base_url,
            api_version=self._api_version,
            small_model=self._small_model,
            large_model=self._large_model,
            embedding_model=self._embedding_model,
            image_model=self._image_model,
            timeout_seconds=seconds,
        )





