from __future__ import annotations

import os

from elizaos_plugin_openrouter.errors import ApiKeyError

DEFAULT_BASE_URL: str = "https://openrouter.ai/api/v1"
DEFAULT_SMALL_MODEL: str = "google/gemini-2.0-flash-001"
DEFAULT_LARGE_MODEL: str = "google/gemini-2.5-flash"
DEFAULT_IMAGE_MODEL: str = "x-ai/grok-2-vision-1212"
DEFAULT_EMBEDDING_MODEL: str = "openai/text-embedding-3-small"
DEFAULT_EMBEDDING_DIMENSIONS: int = 1536
DEFAULT_TIMEOUT_SECONDS: int = 60


class OpenRouterConfig:
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
        return self._api_key

    @property
    def base_url(self) -> str:
        return self._base_url

    @property
    def small_model(self) -> str:
        return self._small_model

    @property
    def large_model(self) -> str:
        return self._large_model

    @property
    def image_model(self) -> str:
        return self._image_model

    @property
    def embedding_model(self) -> str:
        return self._embedding_model

    @property
    def embedding_dimensions(self) -> int:
        return self._embedding_dimensions

    @property
    def timeout_seconds(self) -> int:
        return self._timeout_seconds

    @property
    def chat_completions_url(self) -> str:
        return f"{self._base_url}/chat/completions"

    @property
    def embeddings_url(self) -> str:
        return f"{self._base_url}/embeddings"

    @property
    def models_url(self) -> str:
        return f"{self._base_url}/models"

    def with_base_url(self, base_url: str) -> OpenRouterConfig:
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
