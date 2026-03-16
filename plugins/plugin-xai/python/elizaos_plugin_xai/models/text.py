"""
Text generation model handlers for Grok.

Provides handlers for TEXT_SMALL and TEXT_LARGE model types.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from elizaos.types.runtime import IAgentRuntime

import logging

from elizaos_plugin_xai.grok import GrokClient, GrokConfig, TextGenerationParams

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
    small_model = runtime.get_setting("XAI_SMALL_MODEL") or "grok-3-mini"
    large_model = (
        runtime.get_setting("XAI_MODEL") or runtime.get_setting("XAI_LARGE_MODEL") or "grok-3"
    )

    return GrokConfig(
        api_key=str(api_key),
        base_url=str(base_url),
        small_model=str(small_model),
        large_model=str(large_model),
    )


async def handle_text_small(
    runtime: IAgentRuntime,
    params: dict[str, Any],
) -> str:
    """Handle TEXT_SMALL model requests using grok-3-mini."""
    log = _get_logger()
    config = _get_grok_config(runtime)
    log.debug(f"[Grok] Generating text with model: {config.small_model}")

    client = GrokClient(config)
    try:
        text_params = TextGenerationParams(
            prompt=params.get("prompt", ""),
            system=params.get("system"),
            temperature=params.get("temperature", 0.7),
            max_tokens=params.get("maxTokens") or params.get("max_tokens"),
            stop_sequences=params.get("stopSequences") or params.get("stop_sequences"),
            stream=params.get("stream", False),
        )

        result = await client.generate_text(text_params, use_large_model=False)
        return result.text
    finally:
        await client.close()


async def handle_text_large(
    runtime: IAgentRuntime,
    params: dict[str, Any],
) -> str:
    """Handle TEXT_LARGE model requests using grok-3."""
    log = _get_logger()
    config = _get_grok_config(runtime)
    log.debug(f"[Grok] Generating text with model: {config.large_model}")

    client = GrokClient(config)
    try:
        text_params = TextGenerationParams(
            prompt=params.get("prompt", ""),
            system=params.get("system"),
            temperature=params.get("temperature", 0.7),
            max_tokens=params.get("maxTokens") or params.get("max_tokens"),
            stop_sequences=params.get("stopSequences") or params.get("stop_sequences"),
            stream=params.get("stream", False),
        )

        result = await client.generate_text(text_params, use_large_model=True)
        return result.text
    finally:
        await client.close()


# Handler definitions
TEXT_SMALL_HANDLER = {
    "name": "TEXT_SMALL",
    "handler": handle_text_small,
}

TEXT_LARGE_HANDLER = {
    "name": "TEXT_LARGE",
    "handler": handle_text_large,
}
