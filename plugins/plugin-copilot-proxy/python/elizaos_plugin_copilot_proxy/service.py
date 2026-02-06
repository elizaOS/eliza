"""Service layer for the Copilot Proxy plugin."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from elizaos_plugin_copilot_proxy.client import CopilotProxyClient, CopilotProxyClientError
from elizaos_plugin_copilot_proxy.config import CopilotProxyConfig
from elizaos_plugin_copilot_proxy.types import TextGenerationParams, TextGenerationResult

if TYPE_CHECKING:
    pass

logger = logging.getLogger(__name__)


class CopilotProxyService:
    """Service for managing Copilot Proxy interactions."""

    def __init__(self, config: CopilotProxyConfig | None = None) -> None:
        self._config = config or CopilotProxyConfig.from_env()
        self._client: CopilotProxyClient | None = None
        self._initialized = False

    async def initialize(self) -> None:
        """Initialize the service."""
        if self._initialized:
            return

        if not self._config.enabled:
            logger.info("[CopilotProxy] Plugin is disabled via COPILOT_PROXY_ENABLED=false")
            raise CopilotProxyClientError("Plugin is disabled")

        self._client = CopilotProxyClient(self._config)

        # Check if the proxy server is available
        if await self._client.health_check():
            logger.info(
                f"[CopilotProxy] Successfully connected to proxy server at {self._config.base_url}"
            )
        else:
            logger.warning(
                f"[CopilotProxy] Proxy server is not available at {self._config.base_url}. "
                "Make sure the Copilot Proxy VS Code extension is running."
            )

        self._initialized = True

    @property
    def is_available(self) -> bool:
        """Check if the service is available."""
        return self._initialized and self._client is not None

    def _get_client(self) -> CopilotProxyClient:
        """Get the client, raising an error if not initialized."""
        if self._client is None:
            raise CopilotProxyClientError("Service not initialized")
        return self._client

    @property
    def small_model(self) -> str:
        """Get the small model ID."""
        return self._config.small_model

    @property
    def large_model(self) -> str:
        """Get the large model ID."""
        return self._config.large_model

    @property
    def context_window(self) -> int:
        """Get the context window size."""
        return self._config.context_window

    @property
    def max_tokens(self) -> int:
        """Get the max tokens setting."""
        return self._config.max_tokens

    async def generate_text(self, params: TextGenerationParams) -> TextGenerationResult:
        """Generate text with the specified parameters."""
        client = self._get_client()
        return await client.generate_text(params)

    async def generate_text_small(self, prompt: str) -> str:
        """Generate text using the small model."""
        logger.debug("[CopilotProxy] Generating text with small model")
        client = self._get_client()
        return await client.generate_text_small(prompt)

    async def generate_text_small_with_options(
        self,
        prompt: str,
        *,
        system: str | None = None,
        max_tokens: int | None = None,
        temperature: float | None = None,
    ) -> str:
        """Generate text using the small model with options."""
        params = TextGenerationParams(
            prompt=prompt,
            model=self._config.small_model,
            system=system,
            max_tokens=max_tokens,
            temperature=temperature,
        )
        result = await self.generate_text(params)
        return result.text

    async def generate_text_large(self, prompt: str) -> str:
        """Generate text using the large model."""
        logger.debug("[CopilotProxy] Generating text with large model")
        client = self._get_client()
        return await client.generate_text_large(prompt)

    async def generate_text_large_with_options(
        self,
        prompt: str,
        *,
        system: str | None = None,
        max_tokens: int | None = None,
        temperature: float | None = None,
    ) -> str:
        """Generate text using the large model with options."""
        params = TextGenerationParams(
            prompt=prompt,
            model=self._config.large_model,
            system=system,
            max_tokens=max_tokens,
            temperature=temperature,
        )
        result = await self.generate_text(params)
        return result.text

    async def generate_object_small(self, prompt: str) -> dict[str, object]:
        """Generate a JSON object using the small model."""
        logger.debug("[CopilotProxy] Generating object with small model")
        client = self._get_client()
        return await client.generate_object(prompt, self._config.small_model)

    async def generate_object_large(self, prompt: str) -> dict[str, object]:
        """Generate a JSON object using the large model."""
        logger.debug("[CopilotProxy] Generating object with large model")
        client = self._get_client()
        return await client.generate_object(prompt, self._config.large_model)

    async def shutdown(self) -> None:
        """Shutdown the service."""
        if self._client:
            await self._client.close()
            self._client = None
        self._initialized = False
        logger.info("[CopilotProxy] Service shut down")


# Global service instance
_service: CopilotProxyService | None = None


def get_service() -> CopilotProxyService:
    """Get or create the global service instance."""
    global _service
    if _service is None:
        _service = CopilotProxyService()
    return _service


async def initialize_service() -> CopilotProxyService:
    """Initialize and return the global service instance."""
    service = get_service()
    await service.initialize()
    return service
