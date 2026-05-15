"""Small OpenAI-compatible completion adapter used by the tau-bench harness.

The vendored tau-bench user simulator expects a LiteLLM-shaped
``completion(...)`` function. Pulling LiteLLM into every benchmark runner made
the harness brittle, so this module preserves the tiny response surface the
runner uses while talking directly to OpenAI-compatible chat-completion APIs.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Mapping


@dataclass
class CompletionMessage:
    role: str = "assistant"
    content: str | None = None
    tool_calls: list[dict[str, Any]] | None = None

    def model_dump(self) -> dict[str, Any]:
        payload: dict[str, Any] = {"role": self.role, "content": self.content}
        if self.tool_calls is not None:
            payload["tool_calls"] = self.tool_calls
        return payload


@dataclass
class CompletionChoice:
    message: CompletionMessage


class CompletionResponse:
    def __init__(
        self,
        *,
        message: CompletionMessage,
        raw: Mapping[str, Any],
        response_cost: float = 0.0,
    ) -> None:
        self.choices = [CompletionChoice(message)]
        self._hidden_params = {"response_cost": response_cost}
        self.raw = raw


_PROVIDER_CONFIG: dict[str, tuple[str, str, str]] = {
    "openai": ("OPENAI_API_KEY", "OPENAI_BASE_URL", "https://api.openai.com/v1"),
    "cerebras": ("CEREBRAS_API_KEY", "CEREBRAS_BASE_URL", "https://api.cerebras.ai/v1"),
    "groq": ("GROQ_API_KEY", "GROQ_BASE_URL", "https://api.groq.com/openai/v1"),
    "openrouter": (
        "OPENROUTER_API_KEY",
        "OPENROUTER_BASE_URL",
        "https://openrouter.ai/api/v1",
    ),
    "vllm": ("VLLM_API_KEY", "VLLM_BASE_URL", "http://localhost:8000/v1"),
}


def _provider_settings(provider: str) -> tuple[str | None, str]:
    provider_key = provider.strip().lower()
    key_env, base_env, default_base = _PROVIDER_CONFIG.get(
        provider_key,
        (f"{provider_key.upper()}_API_KEY", f"{provider_key.upper()}_BASE_URL", ""),
    )
    base_url = os.environ.get(base_env) or os.environ.get("OPENAI_BASE_URL") or default_base
    if not base_url:
        raise ValueError(
            f"No base URL configured for provider {provider!r}; set {base_env}"
        )
    api_key = os.environ.get(key_env)
    if provider_key == "vllm" and not api_key:
        api_key = "EMPTY"
    if not api_key:
        raise ValueError(
            f"Missing API key for provider {provider!r}; set {key_env}"
        )
    return api_key, base_url.rstrip("/")


def _normalise_message(message: Mapping[str, Any]) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "role": message.get("role", "user"),
        "content": message.get("content"),
    }
    if message.get("tool_calls") is not None:
        payload["tool_calls"] = message["tool_calls"]
    if message.get("tool_call_id") is not None:
        payload["tool_call_id"] = message["tool_call_id"]
    if message.get("name") is not None:
        payload["name"] = message["name"]
    return payload


def _parse_message(raw_message: Mapping[str, Any]) -> CompletionMessage:
    tool_calls = raw_message.get("tool_calls")
    if tool_calls is not None and not isinstance(tool_calls, list):
        tool_calls = list(tool_calls)
    return CompletionMessage(
        role=str(raw_message.get("role") or "assistant"),
        content=raw_message.get("content"),
        tool_calls=tool_calls,
    )


def _response_cost(raw: Mapping[str, Any]) -> float:
    usage = raw.get("usage")
    if not isinstance(usage, Mapping):
        return 0.0
    # The benchmark only needs a numeric accumulator. Provider-specific prices
    # are intentionally not guessed here because stale estimates are worse than
    # reporting an unknown cost as zero.
    return float(usage.get("response_cost") or usage.get("cost") or 0.0)


def completion(
    *,
    model: str,
    custom_llm_provider: str = "openai",
    messages: list[Mapping[str, Any]],
    tools: list[Mapping[str, Any]] | None = None,
    temperature: float | None = None,
    timeout: float | None = None,
    max_retries: int | None = None,
    **kwargs: Any,
) -> CompletionResponse:
    """Call an OpenAI-compatible chat-completions endpoint.

    Returns the minimal LiteLLM-compatible shape used by tau-bench:
    ``response.choices[0].message.content``, ``message.model_dump()``, and
    ``response._hidden_params["response_cost"]``.
    """

    api_key, base_url = _provider_settings(custom_llm_provider)
    payload: dict[str, Any] = {
        "model": model,
        "messages": [_normalise_message(message) for message in messages],
    }
    if tools:
        payload["tools"] = tools
    if temperature is not None:
        payload["temperature"] = temperature
    for key in ("max_tokens", "top_p", "tool_choice", "response_format", "seed"):
        if key in kwargs and kwargs[key] is not None:
            payload[key] = kwargs[key]

    body = json.dumps(payload).encode("utf-8")
    request_timeout = float(
        timeout
        or os.environ.get("TAU_BENCH_COMPLETION_TIMEOUT")
        or os.environ.get("BENCHMARK_COMPLETION_TIMEOUT")
        or 120
    )
    attempts = int(max_retries if max_retries is not None else os.environ.get("TAU_BENCH_COMPLETION_RETRIES", "2"))
    last_error: Exception | None = None
    url = f"{base_url}/chat/completions"

    for attempt in range(max(1, attempts + 1)):
        req = urllib.request.Request(
            url,
            data=body,
            method="POST",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Accept": "application/json",
                "Content-Type": "application/json",
                "User-Agent": "elizaos-tau-bench/1.0",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=request_timeout) as response:
                raw = json.loads(response.read().decode("utf-8"))
            choices = raw.get("choices") if isinstance(raw, Mapping) else None
            if not choices:
                raise RuntimeError(f"Provider returned no choices: {raw}")
            message_raw = choices[0].get("message") or {}
            if not isinstance(message_raw, Mapping):
                raise RuntimeError(f"Provider returned invalid message: {message_raw!r}")
            return CompletionResponse(
                message=_parse_message(message_raw),
                raw=raw,
                response_cost=_response_cost(raw),
            )
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:1000]
            last_error = RuntimeError(
                f"{custom_llm_provider} chat completion failed with HTTP {exc.code}: {detail}"
            )
        except Exception as exc:  # noqa: BLE001 - preserve provider/runtime detail
            last_error = exc
        if attempt < attempts:
            time.sleep(min(4.0, 0.5 * (2**attempt)))

    assert last_error is not None
    raise last_error


__all__ = [
    "CompletionChoice",
    "CompletionMessage",
    "CompletionResponse",
    "completion",
]
