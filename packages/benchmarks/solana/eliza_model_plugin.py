"""
Anthropic model plugin for the Eliza Python runtime.

Registers TEXT_LARGE and TEXT_SMALL model handlers that call the Anthropic API
via the anthropic SDK. Used by the benchmark to route LLM calls through
runtime.message_service.handle_message() → runtime.use_model().
"""

import os
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import TYPE_CHECKING

from elizaos.types.model import ModelType
from elizaos.types.plugin import Plugin

if TYPE_CHECKING:
    from elizaos.types.runtime import IAgentRuntime

ANTHROPIC_MODEL = os.getenv("ANTHROPIC_MODEL", "claude-opus-4-6")


async def _anthropic_text_handler(runtime: "IAgentRuntime", params: dict) -> str:
    """Call Anthropic API for text generation. Used for TEXT_LARGE and TEXT_SMALL."""
    import anthropic

    api_key = os.getenv("ANTHROPIC_API_KEY", "")
    model = params.get("model", ANTHROPIC_MODEL)
    system_prompt = params.get("system", "") or ""
    prompt = params.get("prompt", "") or ""
    temperature = params.get("temperature", 0.7)
    max_tokens = params.get("max_tokens", 8192)

    client = anthropic.AsyncAnthropic(api_key=api_key)

    messages = [{"role": "user", "content": prompt}]
    kwargs = {
        "model": model,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "messages": messages,
    }
    if system_prompt:
        kwargs["system"] = system_prompt

    response = await client.messages.create(**kwargs)
    return response.content[0].text


async def _anthropic_stream_handler(
    runtime: "IAgentRuntime", params: dict
) -> AsyncIterator[str]:
    """Streaming Anthropic handler for TEXT_LARGE_STREAM."""
    import anthropic

    api_key = os.getenv("ANTHROPIC_API_KEY", "")
    model = params.get("model", ANTHROPIC_MODEL)
    system_prompt = params.get("system", "") or ""
    prompt = params.get("prompt", "") or ""
    temperature = params.get("temperature", 0.7)
    max_tokens = params.get("max_tokens", 8192)

    client = anthropic.AsyncAnthropic(api_key=api_key)

    messages = [{"role": "user", "content": prompt}]
    kwargs = {
        "model": model,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "messages": messages,
    }
    if system_prompt:
        kwargs["system"] = system_prompt

    async with client.messages.stream(**kwargs) as stream:
        async for text in stream.text_stream:
            yield text


async def _init_anthropic_plugin(
    config: dict[str, str | int | float | bool | None] | None,
    runtime: "IAgentRuntime",
) -> None:
    """Register Anthropic model handlers with the runtime."""
    api_key = os.getenv("ANTHROPIC_API_KEY", "")
    if not api_key:
        runtime.logger.warning("ANTHROPIC_API_KEY not set — anthropic model plugin inactive")
        return

    runtime.register_model(ModelType.TEXT_LARGE, _anthropic_text_handler, "anthropic", priority=10)
    runtime.register_model(ModelType.TEXT_SMALL, _anthropic_text_handler, "anthropic", priority=10)
    runtime.register_streaming_model(
        ModelType.TEXT_LARGE_STREAM, _anthropic_stream_handler, "anthropic", priority=10
    )
    runtime.logger.info("Anthropic model plugin registered (model=%s)", ANTHROPIC_MODEL)


anthropic_model_plugin = Plugin(
    name="anthropic-model",
    description="Anthropic Claude model provider for Eliza runtime",
    init=_init_anthropic_plugin,
)
