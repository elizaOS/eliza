"""Model provider for Copilot Proxy."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from elizaos_plugin_copilot_proxy.config import (
    AVAILABLE_MODELS,
    CopilotProxyConfig,
    DEFAULT_CONTEXT_WINDOW,
    DEFAULT_MAX_TOKENS,
)
from elizaos_plugin_copilot_proxy.service import CopilotProxyService

if TYPE_CHECKING:
    pass


@dataclass
class ModelCost:
    """Cost information for a model."""

    input: float = 0.0
    output: float = 0.0
    cache_read: float = 0.0
    cache_write: float = 0.0


@dataclass
class ModelDefinition:
    """Model definition for Copilot Proxy."""

    id: str
    name: str
    api: str = "openai-completions"
    reasoning: bool = False
    input: list[str] = field(default_factory=lambda: ["text", "image"])
    cost: ModelCost = field(default_factory=ModelCost)
    context_window: int = DEFAULT_CONTEXT_WINDOW
    max_tokens: int = DEFAULT_MAX_TOKENS

    @classmethod
    def create(
        cls,
        model_id: str,
        context_window: int = DEFAULT_CONTEXT_WINDOW,
        max_tokens: int = DEFAULT_MAX_TOKENS,
    ) -> ModelDefinition:
        """Create a model definition."""
        return cls(
            id=model_id,
            name=model_id,
            context_window=context_window,
            max_tokens=max_tokens,
        )


@dataclass
class ModelProviderConfig:
    """Model provider configuration."""

    base_url: str
    small_model: str
    large_model: str
    context_window: int
    max_tokens: int

    @classmethod
    def from_config(cls, config: CopilotProxyConfig) -> ModelProviderConfig:
        """Create from CopilotProxyConfig."""
        return cls(
            base_url=config.base_url,
            small_model=config.small_model,
            large_model=config.large_model,
            context_window=config.context_window,
            max_tokens=config.max_tokens,
        )


def get_available_models(
    context_window: int = DEFAULT_CONTEXT_WINDOW,
    max_tokens: int = DEFAULT_MAX_TOKENS,
) -> list[ModelDefinition]:
    """Get all available model definitions."""
    return [
        ModelDefinition.create(model_id, context_window, max_tokens)
        for model_id in AVAILABLE_MODELS
    ]


def get_default_models() -> list[ModelDefinition]:
    """Get the default available models."""
    return get_available_models()


def is_known_model(model_id: str) -> bool:
    """Check if a model ID is a known model."""
    return model_id in AVAILABLE_MODELS


class CopilotProxyModelProvider:
    """Model provider for Copilot Proxy."""

    def __init__(self, config: CopilotProxyConfig | None = None) -> None:
        self._config = config or CopilotProxyConfig.from_env()
        self._service = CopilotProxyService(self._config)

    async def initialize(self) -> None:
        """Initialize the provider."""
        await self._service.initialize()

    @property
    def is_available(self) -> bool:
        """Check if the provider is available."""
        return self._service.is_available

    @property
    def service(self) -> CopilotProxyService:
        """Get the service."""
        return self._service

    @property
    def small_model(self) -> str:
        """Get the small model ID."""
        return self._service.small_model

    @property
    def large_model(self) -> str:
        """Get the large model ID."""
        return self._service.large_model

    async def generate_text_small(self, prompt: str) -> str:
        """Generate text using the small model."""
        return await self._service.generate_text_small(prompt)

    async def generate_text_large(self, prompt: str) -> str:
        """Generate text using the large model."""
        return await self._service.generate_text_large(prompt)

    async def generate_object_small(self, prompt: str) -> dict[str, object]:
        """Generate a JSON object using the small model."""
        return await self._service.generate_object_small(prompt)

    async def generate_object_large(self, prompt: str) -> dict[str, object]:
        """Generate a JSON object using the large model."""
        return await self._service.generate_object_large(prompt)

    async def shutdown(self) -> None:
        """Shutdown the provider."""
        await self._service.shutdown()
