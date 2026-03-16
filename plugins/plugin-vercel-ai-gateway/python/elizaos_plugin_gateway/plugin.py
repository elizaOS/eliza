from __future__ import annotations

import os
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING

from elizaos_plugin_gateway.client import GatewayClient
from elizaos_plugin_gateway.config import GatewayConfig
from elizaos_plugin_gateway.types import (
    EmbeddingParams,
    ImageDescriptionParams,
    ImageDescriptionResult,
    ImageGenerationParams,
    ImageGenerationResult,
    ImageQuality,
    ImageSize,
    ImageStyle,
    TextGenerationParams,
)

if TYPE_CHECKING:
    from elizaos import Plugin
    from elizaos.types.runtime import IAgentRuntime


class GatewayPlugin:
    def __init__(
        self,
        api_key: str | None = None,
        base_url: str = "https://ai-gateway.vercel.sh/v1",
        small_model: str = "gpt-5-mini",
        large_model: str = "gpt-5",
        embedding_model: str = "text-embedding-3-small",
        embedding_dimensions: int = 1536,
    ) -> None:
        key = (
            api_key
            or os.environ.get("AI_GATEWAY_API_KEY")
            or os.environ.get("AIGATEWAY_API_KEY")
            or os.environ.get("VERCEL_OIDC_TOKEN")
        )
        if not key:
            raise ValueError(
                "AI_GATEWAY_API_KEY, AIGATEWAY_API_KEY, or VERCEL_OIDC_TOKEN "
                "must be provided or set in environment variables"
            )

        self._config = GatewayConfig(
            api_key=key,
            base_url=base_url,
            small_model=small_model,
            large_model=large_model,
            embedding_model=embedding_model,
            embedding_dimensions=embedding_dimensions,
        )
        self._client = GatewayClient(self._config)

    async def close(self) -> None:
        await self._client.close()

    async def __aenter__(self) -> GatewayPlugin:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.close()

    async def generate_text_small(
        self,
        prompt: str,
        *,
        system: str | None = None,
        max_tokens: int | None = None,
    ) -> str:
        params = TextGenerationParams(
            prompt=prompt,
            model=self._config.small_model,
            system=system,
            max_tokens=max_tokens,
        )
        return await self._client.generate_text(params)

    async def generate_text_large(
        self,
        prompt: str,
        *,
        system: str | None = None,
        max_tokens: int | None = None,
    ) -> str:
        """
        Generate text using the large model (gpt-5).

        Args:
            prompt: The prompt for generation.
            system: Optional system message.
            max_tokens: Maximum output tokens.

        Returns:
            Generated text.
        """
        params = TextGenerationParams(
            prompt=prompt,
            model=self._config.large_model,
            system=system,
            max_tokens=max_tokens,
        )
        return await self._client.generate_text(params)

    async def stream_text(
        self,
        prompt: str,
        *,
        model: str | None = None,
        system: str | None = None,
    ) -> AsyncIterator[str]:
        params = TextGenerationParams(
            prompt=prompt,
            model=model or self._config.large_model,
            system=system,
            stream=True,
        )
        async for chunk in self._client.stream_text(params):
            yield chunk

    async def create_embedding(self, text: str) -> list[float]:
        params = EmbeddingParams(
            text=text,
            model=self._config.embedding_model,
            dimensions=self._config.embedding_dimensions,
        )
        return await self._client.create_embedding(params)

    async def generate_image(
        self,
        prompt: str,
        *,
        n: int = 1,
        size: ImageSize = ImageSize.SIZE_1024,
        quality: ImageQuality = ImageQuality.STANDARD,
        style: ImageStyle = ImageStyle.VIVID,
    ) -> list[ImageGenerationResult]:
        params = ImageGenerationParams(
            prompt=prompt,
            model=self._config.image_model,
            n=n,
            size=size,
            quality=quality,
            style=style,
        )
        return await self._client.generate_image(params)

    async def describe_image(
        self,
        image_url: str,
        *,
        prompt: str | None = None,
        max_tokens: int = 8192,
    ) -> ImageDescriptionResult:
        params = ImageDescriptionParams(
            image_url=image_url,
            max_tokens=max_tokens,
        )
        if prompt:
            params = ImageDescriptionParams(
                image_url=image_url,
                prompt=prompt,
                max_tokens=max_tokens,
            )
        return await self._client.describe_image(params)

    async def generate_object(
        self,
        prompt: str,
        *,
        model: str | None = None,
        temperature: float | None = None,
    ) -> dict[str, object]:
        return await self._client.generate_object(prompt, model=model, temperature=temperature)


# Convenience function to create plugin
def create_plugin(
    api_key: str | None = None,
    **kwargs: object,
) -> GatewayPlugin:
    """
    Create a Gateway plugin instance.

    Args:
        api_key: Gateway API key (defaults to AI_GATEWAY_API_KEY env var).
        **kwargs: Additional configuration options.

    Returns:
        Configured GatewayPlugin instance.
    """
    return GatewayPlugin(api_key=api_key, **kwargs)  # type: ignore[arg-type]


# ============================================================================
# elizaOS Plugin (for use with AgentRuntime)
# ============================================================================


def create_gateway_elizaos_plugin() -> Plugin:
    """
    Create an elizaOS-compatible plugin for Vercel AI Gateway.

    This creates a proper elizaOS Plugin that can be passed to AgentRuntime.
    The plugin registers model handlers for TEXT_LARGE, TEXT_SMALL, and TEXT_EMBEDDING.

    Configuration is read from environment variables:
    - AI_GATEWAY_API_KEY or AIGATEWAY_API_KEY or VERCEL_OIDC_TOKEN (required)
    - AI_GATEWAY_BASE_URL (optional)
    - AI_GATEWAY_SMALL_MODEL (optional, default: gpt-5-mini)
    - AI_GATEWAY_LARGE_MODEL (optional, default: gpt-5)
    """
    from typing import Any

    from elizaos import Plugin
    from elizaos.types.model import ModelType

    _client: GatewayPlugin | None = None

    def _get_client() -> GatewayPlugin:
        nonlocal _client
        if _client is None:
            _client = GatewayPlugin(
                api_key=os.environ.get("AI_GATEWAY_API_KEY")
                or os.environ.get("AIGATEWAY_API_KEY")
                or os.environ.get("VERCEL_OIDC_TOKEN"),
                base_url=os.environ.get("AI_GATEWAY_BASE_URL", "https://ai-gateway.vercel.sh/v1"),
                small_model=os.environ.get("AI_GATEWAY_SMALL_MODEL", "gpt-5-mini"),
                large_model=os.environ.get("AI_GATEWAY_LARGE_MODEL", "gpt-5"),
            )
        return _client

    async def text_large_handler(runtime: IAgentRuntime, params: dict[str, Any]) -> str:
        client = _get_client()
        return await client.generate_text_large(
            params.get("prompt", ""),
            system=params.get("system"),
            max_tokens=params.get("maxTokens"),
        )

    async def text_small_handler(runtime: IAgentRuntime, params: dict[str, Any]) -> str:
        client = _get_client()
        return await client.generate_text_small(
            params.get("prompt", ""),
            system=params.get("system"),
            max_tokens=params.get("maxTokens"),
        )

    async def embedding_handler(runtime: IAgentRuntime, params: dict[str, Any]) -> list[float]:
        client = _get_client()
        return await client.create_embedding(params.get("text", ""))

    return Plugin(
        name="gateway",
        description="Vercel AI Gateway model provider for elizaOS",
        models={
            ModelType.TEXT_LARGE: text_large_handler,
            ModelType.TEXT_SMALL: text_small_handler,
            ModelType.TEXT_EMBEDDING: embedding_handler,
        },
    )


_gateway_plugin_instance: Plugin | None = None


def get_gateway_plugin() -> Plugin:
    global _gateway_plugin_instance
    if _gateway_plugin_instance is None:
        _gateway_plugin_instance = create_gateway_elizaos_plugin()
    return _gateway_plugin_instance
