"""
Embedding model handler for Grok.

Provides handler for TEXT_EMBEDDING model type using grok-embedding.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from elizaos.types.runtime import IAgentRuntime

import logging

from elizaos_plugin_xai.grok import EmbeddingParams, GrokClient, GrokConfig

logger: logging.Logger | None = None


def _get_logger() -> logging.Logger:
    """Lazy import logger to avoid circular imports."""
    global logger
    if logger is None:
        from elizaos.logger import create_logger

        logger = create_logger(__name__)
    return logger


def _get_grok_config(runtime: IAgentRuntime) -> GrokConfig:
    """Get Grok configuration from runtime settings."""
    api_key = runtime.get_setting("XAI_API_KEY")
    if not api_key:
        raise ValueError("XAI_API_KEY is required")

    base_url = runtime.get_setting("XAI_BASE_URL") or "https://api.x.ai/v1"
    embedding_model = runtime.get_setting("XAI_EMBEDDING_MODEL") or "grok-embedding"

    return GrokConfig(
        api_key=str(api_key),
        base_url=str(base_url),
        embedding_model=str(embedding_model),
    )


async def handle_text_embedding(
    runtime: IAgentRuntime,
    params: dict[str, Any] | str | None,
) -> list[float]:
    """Handle TEXT_EMBEDDING model requests using grok-embedding."""
    if params is None:
        raise ValueError("Null params provided for embedding")

    # Handle both dict params and string params
    if isinstance(params, str):
        text = params
    else:
        text = params.get("text", "") if isinstance(params, dict) else ""

    if not text:
        raise ValueError("Empty text provided for embedding")

    log = _get_logger()
    config = _get_grok_config(runtime)
    log.debug(f"[Grok] Creating embedding with model: {config.embedding_model}")

    client = GrokClient(config)
    try:
        embedding_params = EmbeddingParams(text=text)
        return await client.create_embedding(embedding_params)
    finally:
        await client.close()


# Handler definition
TEXT_EMBEDDING_HANDLER = {
    "name": "TEXT_EMBEDDING",
    "handler": handle_text_embedding,
}
