from __future__ import annotations

import os

from elizaos_plugin_anthropic.errors import ApiKeyError
from elizaos_plugin_anthropic.models import Model

DEFAULT_BASE_URL: str = "https://api.anthropic.com"
DEFAULT_API_VERSION: str = "2023-06-01"
DEFAULT_TIMEOUT_SECONDS: int = 60


class AnthropicConfig:
    _api_key: str
    _base_url: str
    _api_version: str
    _small_model: Model
    _large_model: Model
    _timeout_seconds: int

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = DEFAULT_BASE_URL,
        api_version: str = DEFAULT_API_VERSION,
        small_model: Model | None = None,
        large_model: Model | None = None,
        timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        if not api_key or not api_key.strip():
            raise ApiKeyError("API key cannot be empty")

        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._api_version = api_version
        self._small_model = small_model or Model.small()
        self._large_model = large_model or Model.large()
        self._timeout_seconds = timeout_seconds

    @classmethod
    def from_env(cls) -> AnthropicConfig:
        api_key = os.environ.get("ANTHROPIC_API_KEY", "")
        if not api_key:
            raise ApiKeyError(
                "ANTHROPIC_API_KEY environment variable is not set. "
                "Please set it to your Anthropic API key."
            )

        base_url = os.environ.get("ANTHROPIC_BASE_URL") or DEFAULT_BASE_URL

        small_model_id = os.environ.get("ANTHROPIC_SMALL_MODEL")
        small_model = Model(small_model_id) if small_model_id else None

        large_model_id = os.environ.get("ANTHROPIC_LARGE_MODEL")
        large_model = Model(large_model_id) if large_model_id else None

        timeout_str = os.environ.get("ANTHROPIC_TIMEOUT_SECONDS")
        timeout_seconds = int(timeout_str) if timeout_str else DEFAULT_TIMEOUT_SECONDS

        return cls(
            api_key=api_key,
            base_url=base_url,
            small_model=small_model,
            large_model=large_model,
            timeout_seconds=timeout_seconds,
        )

    @property
    def api_key(self) -> str:
        return self._api_key

    @property
    def base_url(self) -> str:
        return self._base_url

    @property
    def api_version(self) -> str:
        return self._api_version

    @property
    def small_model(self) -> Model:
        return self._small_model

    @property
    def large_model(self) -> Model:
        return self._large_model

    @property
    def timeout_seconds(self) -> int:
        return self._timeout_seconds

    @property
    def messages_url(self) -> str:
        return f"{self._base_url}/v1/messages"

    def with_base_url(self, base_url: str) -> AnthropicConfig:
        return AnthropicConfig(
            api_key=self._api_key,
            base_url=base_url,
            api_version=self._api_version,
            small_model=self._small_model,
            large_model=self._large_model,
            timeout_seconds=self._timeout_seconds,
        )

    def with_timeout(self, seconds: int) -> AnthropicConfig:
        return AnthropicConfig(
            api_key=self._api_key,
            base_url=self._base_url,
            api_version=self._api_version,
            small_model=self._small_model,
            large_model=self._large_model,
            timeout_seconds=seconds,
        )

    def with_small_model(self, model: Model) -> AnthropicConfig:
        return AnthropicConfig(
            api_key=self._api_key,
            base_url=self._base_url,
            api_version=self._api_version,
            small_model=model,
            large_model=self._large_model,
            timeout_seconds=self._timeout_seconds,
        )

    def with_large_model(self, model: Model) -> AnthropicConfig:
        return AnthropicConfig(
            api_key=self._api_key,
            base_url=self._base_url,
            api_version=self._api_version,
            small_model=self._small_model,
            large_model=model,
            timeout_seconds=self._timeout_seconds,
        )
