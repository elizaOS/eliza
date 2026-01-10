"""
Configuration for the Anthropic client.

Configuration is loaded from environment variables or provided explicitly.
All required values must be present - no defaults for secrets.
"""

from __future__ import annotations

import os

from elizaos_plugin_anthropic.errors import ApiKeyError
from elizaos_plugin_anthropic.models import Model

# Default values
DEFAULT_BASE_URL: str = "https://api.anthropic.com"
DEFAULT_API_VERSION: str = "2023-06-01"
DEFAULT_TIMEOUT_SECONDS: int = 60


class AnthropicConfig:
    """Configuration for the Anthropic client."""

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
        """
        Create a new configuration with an API key.

        Args:
            api_key: The Anthropic API key (required).
            base_url: Base URL for the API.
            api_version: API version string.
            small_model: Model to use for small text generation.
            large_model: Model to use for large text generation.
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
        self._timeout_seconds = timeout_seconds

    @classmethod
    def from_env(cls) -> "AnthropicConfig":
        """
        Load configuration from environment variables.

        Required:
            ANTHROPIC_API_KEY

        Optional:
            ANTHROPIC_BASE_URL (default: https://api.anthropic.com)
            ANTHROPIC_SMALL_MODEL (default: claude-3-5-haiku-20241022)
            ANTHROPIC_LARGE_MODEL (default: claude-sonnet-4-20250514)
            ANTHROPIC_TIMEOUT_SECONDS (default: 60)

        Returns:
            Configured AnthropicConfig instance.

        Raises:
            ApiKeyError: If ANTHROPIC_API_KEY is not set or is empty.
        """
        api_key = os.environ.get("ANTHROPIC_API_KEY", "")
        if not api_key:
            raise ApiKeyError(
                "ANTHROPIC_API_KEY environment variable is not set. "
                "Please set it to your Anthropic API key."
            )

        base_url = os.environ.get("ANTHROPIC_BASE_URL", DEFAULT_BASE_URL)

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
    def timeout_seconds(self) -> int:
        """Get the timeout in seconds."""
        return self._timeout_seconds

    @property
    def messages_url(self) -> str:
        """Get the full messages endpoint URL."""
        return f"{self._base_url}/v1/messages"

    def with_base_url(self, base_url: str) -> "AnthropicConfig":
        """Create a new config with a different base URL."""
        return AnthropicConfig(
            api_key=self._api_key,
            base_url=base_url,
            api_version=self._api_version,
            small_model=self._small_model,
            large_model=self._large_model,
            timeout_seconds=self._timeout_seconds,
        )

    def with_timeout(self, seconds: int) -> "AnthropicConfig":
        """Create a new config with a different timeout."""
        return AnthropicConfig(
            api_key=self._api_key,
            base_url=self._base_url,
            api_version=self._api_version,
            small_model=self._small_model,
            large_model=self._large_model,
            timeout_seconds=seconds,
        )


