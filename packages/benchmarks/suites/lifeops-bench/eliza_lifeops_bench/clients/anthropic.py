"""Anthropic Claude inference client.

Used as the live judge model for LifeOpsBench. Anthropic was deliberately
chosen as judge because it is *different* from the Cerebras subject model —
self-judging would inflate scores via self-agreement bias.

Pricing constants below are the public Opus tier prices from
https://www.anthropic.com/pricing (USD per million tokens).
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from typing import Any, Final

from .base import (
    BaseClient,
    ClientCall,
    ClientResponse,
    FinishReason,
    ProviderError,
    ToolCall,
    Usage,
)

ANTHROPIC_PRICING: Final[dict[str, dict[str, float]]] = {
    "claude-opus-4-7": {
        "input_per_million_usd": 15.00,
        "output_per_million_usd": 75.00,
        "cache_read_per_million_usd": 1.50,
    },
    # Haiku tier, used in some non-judge eval modes.
    "claude-haiku-4-5-20251001": {
        "input_per_million_usd": 1.00,
        "output_per_million_usd": 5.00,
        "cache_read_per_million_usd": 0.10,
    },
}

_DEFAULT_MODEL: Final[str] = "claude-opus-4-7"
_RETRY_BACKOFF_SECONDS: Final[float] = 2.0
_REQUEST_TIMEOUT_SECONDS: Final[float] = 90.0


def _import_anthropic_sdk() -> Any:
    """Lazy-import anthropic SDK with a clear error if missing."""
    try:
        import anthropic  # type: ignore[import-not-found]
    except ImportError as exc:
        raise ProviderError(
            "anthropic SDK not installed; install with: "
            "pip install 'eliza-lifeops-bench[anthropic]' "
            "(or `pip install anthropic`).",
            status=None,
            body=None,
            provider="anthropic",
        ) from exc
    return anthropic


def _split_system_messages(
    messages: list[dict[str, Any]],
) -> tuple[str | None, list[dict[str, Any]]]:
    """Pull all system-role messages out and concatenate them.

    Anthropic's Messages API takes ``system`` as a top-level string (or a list
    of content blocks); the rest of the conversation must alternate user /
    assistant. The OpenAI-style messages list mixes system in.
    """
    system_parts: list[str] = []
    rest: list[dict[str, Any]] = []
    for msg in messages:
        role = msg.get("role")
        if role == "system":
            content = msg.get("content")
            if isinstance(content, str) and content:
                system_parts.append(content)
            elif isinstance(content, list):
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "text":
                        text = block.get("text")
                        if isinstance(text, str):
                            system_parts.append(text)
        else:
            rest.append(msg)
    system = "\n\n".join(system_parts) if system_parts else None
    return system, rest


def _convert_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Convert OpenAI-shaped messages to Anthropic's content-block format.

    - assistant message with ``tool_calls`` → ``content: [{type: "tool_use", id, name, input}]``
      (plus any preceding text content as a separate text block)
    - tool role message → user-role message with
      ``content: [{type: "tool_result", tool_use_id, content}]``
    - plain text messages stay as ``content: <str>``
    """
    converted: list[dict[str, Any]] = []
    for msg in messages:
        role = msg.get("role")
        if role == "tool":
            tool_call_id = msg.get("tool_call_id")
            if not isinstance(tool_call_id, str):
                raise ProviderError(
                    "tool message missing tool_call_id",
                    status=None,
                    body=str(msg),
                    provider="anthropic",
                )
            content = msg.get("content")
            content_str = content if isinstance(content, str) else str(content)
            converted.append(
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": tool_call_id,
                            "content": content_str,
                        }
                    ],
                }
            )
            continue

        if role == "assistant":
            tool_calls = msg.get("tool_calls")
            text_content = msg.get("content")
            blocks: list[dict[str, Any]] = []
            if isinstance(text_content, str) and text_content:
                blocks.append({"type": "text", "text": text_content})
            if isinstance(tool_calls, list):
                for tc in tool_calls:
                    function = tc.get("function") or {}
                    arguments_raw = function.get("arguments")
                    if isinstance(arguments_raw, str):
                        try:
                            arguments = (
                                json.loads(arguments_raw) if arguments_raw else {}
                            )
                        except json.JSONDecodeError as exc:
                            raise ProviderError(
                                "Anthropic tool_call arguments were not valid JSON",
                                status=None,
                                body=str(msg),
                                provider="anthropic",
                            ) from exc
                    elif isinstance(arguments_raw, dict):
                        arguments = arguments_raw
                    else:
                        arguments = {}
                    blocks.append(
                        {
                            "type": "tool_use",
                            "id": tc.get("id") or f"call_{len(blocks)}",
                            "name": function.get("name") or "",
                            "input": arguments,
                        }
                    )
            converted.append(
                {
                    "role": "assistant",
                    "content": blocks if blocks else (text_content or ""),
                }
            )
            continue

        if role == "user":
            content = msg.get("content")
            converted.append(
                {
                    "role": "user",
                    "content": content if content is not None else "",
                }
            )
            continue

        raise ProviderError(
            f"Unsupported message role for Anthropic: {role!r}",
            status=None,
            body=str(msg),
            provider="anthropic",
        )
    return converted


def _convert_tools(tools: list[dict[str, Any]] | None) -> list[dict[str, Any]] | None:
    """Convert OpenAI-format tool definitions to Anthropic's shape.

    OpenAI: ``{type: "function", function: {name, description, parameters}}``
    Anthropic: ``{name, description, input_schema}``
    """
    if not tools:
        return None
    converted: list[dict[str, Any]] = []
    for tool in tools:
        function = tool.get("function") or tool
        name = function.get("name")
        if not isinstance(name, str) or not name:
            raise ProviderError(
                "tool definition missing function.name",
                status=None,
                body=str(tool),
                provider="anthropic",
            )
        converted.append(
            {
                "name": name,
                "description": function.get("description", ""),
                "input_schema": function.get("parameters") or {"type": "object", "properties": {}},
            }
        )
    return converted


def _resolve_finish_reason(stop_reason: str | None) -> FinishReason:
    """Map Anthropic ``stop_reason`` to the benchmark FinishReason union."""
    if stop_reason == "tool_use":
        return "tool_calls"
    if stop_reason == "end_turn":
        return "stop"
    if stop_reason == "max_tokens":
        return "length"
    if stop_reason == "stop_sequence":
        return "stop"
    return "error"


def _compute_cost_usd(
    model: str,
    input_tokens: int,
    output_tokens: int,
    cache_read_tokens: int,
) -> float | None:
    """Compute USD cost for an Anthropic call.

    Returns :data:`None` when ``model`` is not in :data:`ANTHROPIC_PRICING`
    — per AGENTS.md Cmd #8 an unpriced model stays nullable rather than
    silently looking like a free call.
    """
    pricing = ANTHROPIC_PRICING.get(model)
    if pricing is None:
        return None
    billable_input = max(0, input_tokens - cache_read_tokens)
    cost = (
        billable_input / 1_000_000.0 * pricing["input_per_million_usd"]
        + output_tokens / 1_000_000.0 * pricing["output_per_million_usd"]
        + cache_read_tokens / 1_000_000.0 * pricing["cache_read_per_million_usd"]
    )
    return cost


def _status_code_from_exception(exc: Exception) -> int | None:
    """Return a provider HTTP status code without importing the optional SDK."""
    status = getattr(exc, "status_code", None)
    if isinstance(status, int):
        return status
    response = getattr(exc, "response", None)
    status = getattr(response, "status_code", None)
    return status if isinstance(status, int) else None


class AnthropicClient(BaseClient):
    """Anthropic Messages API client used as the live judge."""

    def __init__(
        self,
        model: str | None = None,
        api_key: str | None = None,
        *,
        client: Any | None = None,
    ) -> None:
        resolved_key = api_key or os.environ.get("ANTHROPIC_API_KEY", "").strip()
        if not resolved_key and client is None:
            raise ProviderError(
                "ANTHROPIC_API_KEY is not set; required for AnthropicClient.",
                status=None,
                body=None,
                provider="anthropic",
            )
        self.model_name = model or os.environ.get("ANTHROPIC_MODEL") or _DEFAULT_MODEL
        self._api_key = resolved_key
        if client is not None:
            self._client = client
        else:
            # Keep construction side-effect free for factory tests and CLI
            # config resolution. The optional SDK is required only when a real
            # request is made.
            self._client = None

    def _build_kwargs(self, call: ClientCall) -> dict[str, Any]:
        system, rest = _split_system_messages(call.messages)
        kwargs: dict[str, Any] = {
            "model": self.model_name,
            "messages": _convert_messages(rest),
            "temperature": call.temperature,
            # Anthropic requires max_tokens; default to a generous cap so judge
            # rationales aren't truncated. Callers should set this explicitly.
            "max_tokens": call.max_tokens if call.max_tokens is not None else 4096,
        }
        if system is not None:
            kwargs["system"] = system
        tools = _convert_tools(call.tools)
        if tools is not None:
            kwargs["tools"] = tools
        if call.extra:
            kwargs.update(call.extra)
        return kwargs

    async def _create_once(self, kwargs: dict[str, Any]) -> Any:
        if self._client is None:
            anthropic = _import_anthropic_sdk()
            self._client = anthropic.AsyncAnthropic(
                api_key=self._api_key,
                timeout=_REQUEST_TIMEOUT_SECONDS,
            )
        return await self._client.messages.create(**kwargs)

    async def complete(self, call: ClientCall) -> ClientResponse:
        kwargs = self._build_kwargs(call)
        start_ns = time.perf_counter_ns()
        try:
            response = await self._create_once(kwargs)
        except Exception as exc:
            status = _status_code_from_exception(exc)
            if status == 429 or (isinstance(status, int) and status >= 500):
                await asyncio.sleep(_RETRY_BACKOFF_SECONDS)
                response = await self._create_once(kwargs)
            elif status is not None:
                raise ProviderError(
                    f"Anthropic error {status}",
                    status=status,
                    body=str(getattr(exc, "body", None) or exc),
                    provider="anthropic",
                ) from exc
            else:
                raise
        latency_ms = (time.perf_counter_ns() - start_ns) // 1_000_000

        # The SDK returns a typed object; normalize to dict-like access via
        # model_dump when available, falling back to attribute reads.
        if hasattr(response, "model_dump"):
            raw: dict[str, Any] = response.model_dump()
        else:
            raw = dict(response)  # type: ignore[arg-type]

        content_blocks = raw.get("content") or []
        text_parts: list[str] = []
        tool_calls: list[ToolCall] = []
        for block in content_blocks:
            block_type = block.get("type")
            if block_type == "text":
                text = block.get("text")
                if isinstance(text, str):
                    text_parts.append(text)
            elif block_type == "tool_use":
                tool_calls.append(
                    ToolCall(
                        id=str(block.get("id") or f"call_{len(tool_calls)}"),
                        name=str(block.get("name") or ""),
                        arguments=block.get("input") or {},
                    )
                )
        content = "".join(text_parts) if text_parts else None

        finish_reason = _resolve_finish_reason(raw.get("stop_reason"))

        usage_raw = raw.get("usage") or {}
        input_tokens = int(usage_raw.get("input_tokens") or 0)
        output_tokens = int(usage_raw.get("output_tokens") or 0)
        # Anthropic surfaces both halves of prompt caching directly.
        cache_read_raw = usage_raw.get("cache_read_input_tokens")
        cache_creation_raw = usage_raw.get("cache_creation_input_tokens")
        cache_read_value: int | None = (
            int(cache_read_raw) if isinstance(cache_read_raw, (int, float)) else None
        )
        cache_creation_value: int | None = (
            int(cache_creation_raw)
            if isinstance(cache_creation_raw, (int, float))
            else None
        )
        cache_read_tokens = cache_read_value if cache_read_value is not None else 0
        usage = Usage(
            prompt_tokens=input_tokens,
            completion_tokens=output_tokens,
            total_tokens=input_tokens + output_tokens,
            cached_tokens=cache_read_tokens,
            cache_read_input_tokens=cache_read_value,
            cache_creation_input_tokens=cache_creation_value,
        )
        cost_usd = _compute_cost_usd(self.model_name, input_tokens, output_tokens, cache_read_tokens)

        return ClientResponse(
            content=content,
            tool_calls=tool_calls,
            finish_reason=finish_reason,
            usage=usage,
            latency_ms=int(latency_ms),
            cost_usd=cost_usd,
            raw_provider_response=raw,
        )
