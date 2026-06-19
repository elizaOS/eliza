"""Completion client helpers for tau-bench.

LiteLLM is useful when installed, but the benchmark package should still import
and run smoke tests without it. This module gives the harness one completion
surface and falls back to OpenAI-compatible HTTP endpoints for local servers
such as llama.cpp.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
from typing import Any

import httpx


class MissingModelClientDependency(RuntimeError):
    """Raised when no configured completion backend is available."""


@dataclass
class CompletionMessage:
    role: str = "assistant"
    content: str | None = None
    tool_calls: list[dict[str, Any]] | None = None

    def model_dump(self) -> dict[str, Any]:
        return {
            "role": self.role,
            "content": self.content,
            "tool_calls": self.tool_calls,
        }


@dataclass
class CompletionChoice:
    message: CompletionMessage


class CompletionResponse:
    def __init__(self, message: CompletionMessage, response_cost: float = 0.0) -> None:
        self.choices = [CompletionChoice(message)]
        self._hidden_params = {"response_cost": response_cost}


def _provider_base_url(provider: str | None) -> str | None:
    provider_key = (provider or "").strip().lower()
    if provider_key in {"llama.cpp", "llamacpp", "llama-cpp", "local", "openai-compatible"}:
        return (
            os.environ.get("TAU_BENCH_OPENAI_BASE_URL")
            or os.environ.get("OPENAI_BASE_URL")
            or os.environ.get("LLAMA_CPP_BASE_URL")
            or "http://127.0.0.1:8080/v1"
        )
    return os.environ.get("TAU_BENCH_OPENAI_BASE_URL")


def _openai_compatible_completion(
    *,
    model: str,
    custom_llm_provider: str | None = None,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None = None,
    temperature: float | None = None,
    **kwargs: Any,
) -> CompletionResponse:
    base_url = _provider_base_url(custom_llm_provider)
    if not base_url:
        raise MissingModelClientDependency(
            "litellm is not installed and no OpenAI-compatible endpoint is configured. "
            "Install litellm or set TAU_BENCH_OPENAI_BASE_URL/OPENAI_BASE_URL."
        )

    api_key = (
        os.environ.get("TAU_BENCH_OPENAI_API_KEY")
        or os.environ.get("OPENAI_API_KEY")
        or "local-no-key"
    )
    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
    }
    if tools:
        payload["tools"] = tools
    if temperature is not None:
        payload["temperature"] = temperature
    for key in ("tool_choice", "max_tokens", "response_format"):
        if key in kwargs and kwargs[key] is not None:
            payload[key] = kwargs[key]

    url = base_url.rstrip("/") + "/chat/completions"
    with httpx.Client(timeout=float(os.environ.get("TAU_BENCH_COMPLETION_TIMEOUT", "120"))) as client:
        response = client.post(
            url,
            headers={"Authorization": f"Bearer {api_key}"},
            json=payload,
        )
        response.raise_for_status()
    raw = response.json()
    msg = raw["choices"][0]["message"]
    usage = raw.get("usage") or {}
    cost = float(usage.get("cost") or usage.get("response_cost") or 0.0)
    return CompletionResponse(
        CompletionMessage(
            role=msg.get("role", "assistant"),
            content=msg.get("content"),
            tool_calls=msg.get("tool_calls"),
        ),
        response_cost=cost,
    )


def _sanitize_messages(messages: Any) -> Any:
    """Remove provider-emitted fields that OpenAI-compatible APIs reject.

    Cerebras gpt-oss models can return ``reasoning_content`` on assistant
    messages. The field is useful telemetry, but the chat-completions API
    rejects it if a benchmark later replays the message history.
    """
    if not isinstance(messages, list):
        return messages
    sanitized: list[Any] = []
    for item in messages:
        if not isinstance(item, dict):
            sanitized.append(item)
            continue
        msg = dict(item)
        if msg.get("role") == "assistant":
            msg.pop("reasoning_content", None)
            msg.pop("provider_specific_fields", None)
        sanitized.append(msg)
    return sanitized


def _looks_retryable(exc: Exception) -> bool:
    text = str(exc).lower()
    return (
        "rate limit" in text
        or "too many requests" in text
        or "queue_exceeded" in text
        or "high traffic" in text
    )


def completion(**kwargs: Any) -> Any:
    """Call LiteLLM when present, otherwise an OpenAI-compatible endpoint."""
    if "messages" in kwargs:
        kwargs = {**kwargs, "messages": _sanitize_messages(kwargs.get("messages"))}
    provider_key = str(kwargs.get("custom_llm_provider") or "").strip().lower()
    if provider_key in {"llama.cpp", "llamacpp", "llama-cpp", "local", "openai-compatible"}:
        return _openai_compatible_completion(**kwargs)
    try:
        from litellm import completion as litellm_completion  # type: ignore
    except Exception:
        return _openai_compatible_completion(**kwargs)
    delays = (0.0, 2.0, 5.0, 10.0)
    last_exc: Exception | None = None
    for delay in delays:
        if delay:
            time.sleep(delay)
        try:
            return litellm_completion(**kwargs)
        except Exception as exc:
            last_exc = exc
            if not _looks_retryable(exc):
                raise
    assert last_exc is not None
    raise last_exc


__all__ = [
    "CompletionMessage",
    "CompletionResponse",
    "MissingModelClientDependency",
    "completion",
]
