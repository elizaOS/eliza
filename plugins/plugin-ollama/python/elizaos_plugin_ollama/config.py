from __future__ import annotations

import os

from elizaos_plugin_ollama.errors import ConfigError

DEFAULT_BASE_URL: str = "http://localhost:11434"
DEFAULT_SMALL_MODEL: str = "gemma3:latest"
DEFAULT_LARGE_MODEL: str = "gemma3:latest"
DEFAULT_EMBEDDING_MODEL: str = "nomic-embed-text:latest"
DEFAULT_TIMEOUT_SECONDS: int = 300


class OllamaConfig:
    _base_url: str
    _small_model: str
    _large_model: str
    _embedding_model: str
    _timeout_seconds: int

    def __init__(
        self,
        *,
        base_url: str = DEFAULT_BASE_URL,
        small_model: str = DEFAULT_SMALL_MODEL,
        large_model: str = DEFAULT_LARGE_MODEL,
        embedding_model: str = DEFAULT_EMBEDDING_MODEL,
        timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        if not base_url:
            raise ConfigError("Base URL cannot be empty")

        self._base_url = base_url.rstrip("/")
        self._small_model = small_model
        self._large_model = large_model
        self._embedding_model = embedding_model
        self._timeout_seconds = timeout_seconds

    @classmethod
    def from_env(cls) -> OllamaConfig:
        base_url = (
            os.environ.get("OLLAMA_API_ENDPOINT")
            or os.environ.get("OLLAMA_API_URL")
            or DEFAULT_BASE_URL
        )

        small_model = (
            os.environ.get("OLLAMA_SMALL_MODEL")
            or os.environ.get("SMALL_MODEL")
            or DEFAULT_SMALL_MODEL
        )

        large_model = (
            os.environ.get("OLLAMA_LARGE_MODEL")
            or os.environ.get("LARGE_MODEL")
            or DEFAULT_LARGE_MODEL
        )

        embedding_model = os.environ.get("OLLAMA_EMBEDDING_MODEL", DEFAULT_EMBEDDING_MODEL)

        timeout_str = os.environ.get("OLLAMA_TIMEOUT_SECONDS")
        timeout_seconds = int(timeout_str) if timeout_str else DEFAULT_TIMEOUT_SECONDS

        return cls(
            base_url=base_url,
            small_model=small_model,
            large_model=large_model,
            embedding_model=embedding_model,
            timeout_seconds=timeout_seconds,
        )

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
    def embedding_model(self) -> str:
        return self._embedding_model

    @property
    def timeout_seconds(self) -> int:
        return self._timeout_seconds

    @property
    def generate_url(self) -> str:
        return f"{self._base_url}/api/generate"

    @property
    def chat_url(self) -> str:
        return f"{self._base_url}/api/chat"

    @property
    def embeddings_url(self) -> str:
        return f"{self._base_url}/api/embeddings"

    @property
    def show_url(self) -> str:
        return f"{self._base_url}/api/show"

    @property
    def pull_url(self) -> str:
        return f"{self._base_url}/api/pull"

    @property
    def tags_url(self) -> str:
        return f"{self._base_url}/api/tags"

    def with_base_url(self, base_url: str) -> OllamaConfig:
        return OllamaConfig(
            base_url=base_url,
            small_model=self._small_model,
            large_model=self._large_model,
            embedding_model=self._embedding_model,
            timeout_seconds=self._timeout_seconds,
        )

    def with_timeout(self, seconds: int) -> OllamaConfig:
        return OllamaConfig(
            base_url=self._base_url,
            small_model=self._small_model,
            large_model=self._large_model,
            embedding_model=self._embedding_model,
            timeout_seconds=seconds,
        )
