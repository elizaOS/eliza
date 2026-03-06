"""elizaOS Copilot Proxy Plugin - OpenAI-compatible local proxy for VS Code Copilot."""

from __future__ import annotations

import os
from typing import TYPE_CHECKING, Any

from elizaos_plugin_copilot_proxy.client import CopilotProxyClient, CopilotProxyClientError
from elizaos_plugin_copilot_proxy.config import (
    AVAILABLE_MODELS,
    DEFAULT_BASE_URL,
    DEFAULT_CONTEXT_WINDOW,
    DEFAULT_LARGE_MODEL,
    DEFAULT_MAX_TOKENS,
    DEFAULT_SMALL_MODEL,
    DEFAULT_TIMEOUT_SECONDS,
    CopilotProxyConfig,
    normalize_base_url,
)
from elizaos_plugin_copilot_proxy.providers import (
    CopilotProxyModelProvider,
    ModelCost,
    ModelDefinition,
    ModelProviderConfig,
    get_available_models,
    get_default_models,
    is_known_model,
)
from elizaos_plugin_copilot_proxy.service import (
    CopilotProxyService,
    get_service,
    initialize_service,
)
from elizaos_plugin_copilot_proxy.types import (
    ChatCompletionChoice,
    ChatCompletionRequest,
    ChatCompletionResponse,
    ChatMessage,
    ChatRole,
    ModelInfo,
    ModelsResponse,
    TextGenerationParams,
    TextGenerationResult,
    TokenUsage,
)

if TYPE_CHECKING:
    from elizaos import Plugin

__version__ = "2.0.0"

__all__ = [
    # Config
    "CopilotProxyConfig",
    "normalize_base_url",
    "AVAILABLE_MODELS",
    "DEFAULT_BASE_URL",
    "DEFAULT_SMALL_MODEL",
    "DEFAULT_LARGE_MODEL",
    "DEFAULT_TIMEOUT_SECONDS",
    "DEFAULT_MAX_TOKENS",
    "DEFAULT_CONTEXT_WINDOW",
    # Client
    "CopilotProxyClient",
    "CopilotProxyClientError",
    # Service
    "CopilotProxyService",
    "get_service",
    "initialize_service",
    # Providers
    "CopilotProxyModelProvider",
    "ModelCost",
    "ModelDefinition",
    "ModelProviderConfig",
    "get_available_models",
    "get_default_models",
    "is_known_model",
    # Types
    "ChatRole",
    "ChatMessage",
    "ChatCompletionRequest",
    "ChatCompletionChoice",
    "ChatCompletionResponse",
    "TokenUsage",
    "TextGenerationParams",
    "TextGenerationResult",
    "ModelInfo",
    "ModelsResponse",
    # Plugin
    "CopilotProxyPlugin",
    "create_plugin",
    "get_copilot_proxy_plugin",
    "create_copilot_proxy_elizaos_plugin",
]


class CopilotProxyPlugin:
    """High-level Copilot Proxy plugin wrapper."""

    def __init__(
        self,
        base_url: str | None = None,
        small_model: str | None = None,
        large_model: str | None = None,
        timeout_seconds: int | None = None,
        max_tokens: int | None = None,
        context_window: int | None = None,
    ) -> None:
        config = CopilotProxyConfig.from_env()

        if base_url:
            config = CopilotProxyConfig(
                base_url=base_url,
                small_model=small_model or config.small_model,
                large_model=large_model or config.large_model,
                enabled=config.enabled,
                timeout_seconds=timeout_seconds or config.timeout_seconds,
                max_tokens=max_tokens or config.max_tokens,
                context_window=context_window or config.context_window,
            )
        elif any([small_model, large_model, timeout_seconds, max_tokens, context_window]):
            config = CopilotProxyConfig(
                base_url=config.base_url,
                small_model=small_model or config.small_model,
                large_model=large_model or config.large_model,
                enabled=config.enabled,
                timeout_seconds=timeout_seconds or config.timeout_seconds,
                max_tokens=max_tokens or config.max_tokens,
                context_window=context_window or config.context_window,
            )

        self._provider = CopilotProxyModelProvider(config)

    async def initialize(self) -> None:
        """Initialize the plugin."""
        await self._provider.initialize()

    async def close(self) -> None:
        """Close the plugin."""
        await self._provider.shutdown()

    async def __aenter__(self) -> CopilotProxyPlugin:
        await self.initialize()
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.close()

    @property
    def is_available(self) -> bool:
        """Check if the plugin is available."""
        return self._provider.is_available

    @property
    def small_model(self) -> str:
        """Get the small model ID."""
        return self._provider.small_model

    @property
    def large_model(self) -> str:
        """Get the large model ID."""
        return self._provider.large_model

    async def generate_text(self, prompt: str) -> str:
        """Generate text using the default (large) model."""
        return await self._provider.generate_text_large(prompt)

    async def generate_text_small(self, prompt: str) -> str:
        """Generate text using the small model."""
        return await self._provider.generate_text_small(prompt)

    async def generate_text_large(self, prompt: str) -> str:
        """Generate text using the large model."""
        return await self._provider.generate_text_large(prompt)

    async def generate_object_small(self, prompt: str) -> dict[str, object]:
        """Generate a JSON object using the small model."""
        return await self._provider.generate_object_small(prompt)

    async def generate_object_large(self, prompt: str) -> dict[str, object]:
        """Generate a JSON object using the large model."""
        return await self._provider.generate_object_large(prompt)


def create_plugin(**kwargs: Any) -> CopilotProxyPlugin:
    """Create a Copilot Proxy plugin."""
    return CopilotProxyPlugin(**kwargs)


def create_copilot_proxy_elizaos_plugin() -> Plugin:
    """Create an elizaOS plugin wired to Copilot Proxy model handlers."""
    from elizaos import Plugin
    from elizaos.types.model import ModelType
    from elizaos.types.runtime import IAgentRuntime

    # Plugin instance (created lazily)
    _plugin: CopilotProxyPlugin | None = None

    def _get_plugin() -> CopilotProxyPlugin:
        nonlocal _plugin
        if _plugin is None:
            _plugin = CopilotProxyPlugin()
        return _plugin

    async def text_large_handler(runtime: IAgentRuntime, params: dict[str, Any]) -> str:
        plugin = _get_plugin()
        if not plugin.is_available:
            await plugin.initialize()
        return await plugin.generate_text_large(params.get("prompt", ""))

    async def text_small_handler(runtime: IAgentRuntime, params: dict[str, Any]) -> str:
        plugin = _get_plugin()
        if not plugin.is_available:
            await plugin.initialize()
        return await plugin.generate_text_small(params.get("prompt", ""))

    async def object_large_handler(
        runtime: IAgentRuntime, params: dict[str, Any]
    ) -> dict[str, object]:
        plugin = _get_plugin()
        if not plugin.is_available:
            await plugin.initialize()
        return await plugin.generate_object_large(params.get("prompt", ""))

    async def object_small_handler(
        runtime: IAgentRuntime, params: dict[str, Any]
    ) -> dict[str, object]:
        plugin = _get_plugin()
        if not plugin.is_available:
            await plugin.initialize()
        return await plugin.generate_object_small(params.get("prompt", ""))

    return Plugin(
        name="copilot-proxy",
        description="Copilot Proxy model provider for elizaOS",
        models={
            ModelType.TEXT_LARGE: text_large_handler,
            ModelType.TEXT_SMALL: text_small_handler,
            ModelType.OBJECT_LARGE: object_large_handler,
            ModelType.OBJECT_SMALL: object_small_handler,
        },
    )


_plugin_instance: Plugin | None = None


def get_copilot_proxy_plugin() -> Plugin:
    """Get the global Copilot Proxy plugin instance."""
    global _plugin_instance
    if _plugin_instance is None:
        _plugin_instance = create_copilot_proxy_elizaos_plugin()
    return _plugin_instance
