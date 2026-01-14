"""
elizaOS xAI Plugin

Plugin definition for elizaOS runtime integration.
"""

from __future__ import annotations

from elizaos.logger import create_logger
from elizaos.types.model import ModelType
from elizaos.types.plugin import Plugin
from elizaos.types.runtime import IAgentRuntime

from elizaos_plugin_xai.actions import POST_ACTION
from elizaos_plugin_xai.client import TwitterClient, TwitterConfig
from elizaos_plugin_xai.grok import GrokClient, GrokConfig
from elizaos_plugin_xai.models import handle_text_embedding, handle_text_large, handle_text_small

logger = create_logger(__name__)


class XAIPlugin:
    name = "xai"
    description = "xAI Grok models and X (formerly Twitter) API integration"

    def __init__(
        self,
        grok_config: GrokConfig | None = None,
        x_config: TwitterConfig | None = None,
    ) -> None:
        self._grok_config = grok_config or GrokConfig.from_env()
        self._x_config = x_config or TwitterConfig.from_env()
        self._grok_client: GrokClient | None = None
        self._x_client: TwitterClient | None = None

    @property
    def grok(self) -> GrokClient | None:
        if self._grok_config is None:
            return None
        if self._grok_client is None:
            self._grok_client = GrokClient(self._grok_config)
        return self._grok_client

    @property
    def x(self) -> TwitterClient:
        if self._x_client is None:
            self._x_client = TwitterClient(self._x_config)
        return self._x_client

    def has_grok(self) -> bool:
        return self._grok_config is not None

    async def close(self) -> None:
        if self._grok_client:
            await self._grok_client.close()
            self._grok_client = None
        if self._x_client:
            await self._x_client.close()
            self._x_client = None

    async def __aenter__(self) -> XAIPlugin:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.close()


def create_plugin(
    grok_config: GrokConfig | None = None,
    x_config: TwitterConfig | None = None,
) -> XAIPlugin:
    return XAIPlugin(grok_config, x_config)


def get_xai_plugin() -> XAIPlugin:
    return XAIPlugin()


def get_xai_elizaos_plugin() -> Plugin:
    """
    Create an elizaOS-compatible plugin for xAI.

    This creates a proper elizaOS Plugin that can be passed to AgentRuntime.
    The plugin registers:
    - POST action for posting to X (formerly Twitter)
    - Model handlers for TEXT_LARGE, TEXT_SMALL, and TEXT_EMBEDDING using Grok

    Configuration is read from environment variables:
    - XAI_API_KEY (required for Grok models)
    - XAI_BASE_URL (optional, default: https://api.x.ai/v1)
    - XAI_SMALL_MODEL (optional, default: grok-3-mini)
    - XAI_LARGE_MODEL (optional, default: grok-3)
    - XAI_EMBEDDING_MODEL (optional, default: grok-embedding)
    - X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET (for X API)
    """

    async def init_plugin(
        plugin_config: dict[str, str | int | float | bool | None],
        runtime: IAgentRuntime,
    ) -> None:
        logger.info("Initializing xAI plugin...")

        api_key = runtime.get_setting("XAI_API_KEY")
        if api_key:
            logger.info("✓ Grok API configured")
        else:
            logger.warning("XAI_API_KEY not set - Grok models will not be available")

        auth_mode = runtime.get_setting("X_AUTH_MODE") or "env"
        has_api_key = runtime.get_setting("X_API_KEY")
        has_bearer = runtime.get_setting("X_BEARER_TOKEN")

        if auth_mode == "env" and has_api_key:
            logger.info("✓ X API configured (OAuth 1.0a)")
        elif auth_mode == "bearer" and has_bearer:
            logger.info("✓ X API configured (Bearer token)")
        elif auth_mode == "oauth":
            logger.info("✓ X API configured (OAuth 2.0)")

    return Plugin(
        name="xai",
        description="xAI Grok models and X (formerly Twitter) API integration",
        init=init_plugin,
        actions=[POST_ACTION],
        models={
            ModelType.TEXT_SMALL.value: handle_text_small,
            ModelType.TEXT_LARGE.value: handle_text_large,
            ModelType.TEXT_EMBEDDING.value: handle_text_embedding,
        },
    )
