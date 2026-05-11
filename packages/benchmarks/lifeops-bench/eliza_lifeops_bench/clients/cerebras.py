"""Cerebras inference client (OpenAI-compatible chat-completions).

Targets the public Cerebras inference API. Confirmed against
https://inference-docs.cerebras.ai/capabilities/tool-use and
https://inference-docs.cerebras.ai/api-reference/chat-completions :

- Endpoint: POST ``{base_url}/chat/completions``
- ``parallel_tool_calls`` is a real boolean field, defaulted to ``False`` for
  the benchmark (gpt-oss-120b sometimes emits multiple parallel calls when a
  scenario expects single-step tool use).
- ``reasoning_effort`` is a top-level **string** (``"low" | "medium" | "high"``),
  not an object — confirmed in the chat-completions API reference and matched
  by the existing TS helper at
  ``plugins/app-lifeops/test/helpers/lifeops-eval-model.ts``.
- ``max_completion_tokens`` is the documented field name (includes reasoning
  tokens). We send that for gpt-oss-style reasoning models.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from typing import Any, Final

import httpx

from .base import (
    BaseClient,
    ClientCall,
    ClientResponse,
    FinishReason,
    ProviderError,
    ToolCall,
    Usage,
)

# Pricing: pay-per-token published by Cerebras for gpt-oss-120b is $0.35/M
# input and $0.75/M output as of May 2026. Sourced from
# https://www.cerebras.ai/blog/cerebras-inference-now-available-via-pay-per-token
# and corroborated by https://pricepertoken.com/pricing-page/model/openai-gpt-oss-120b.
# Override per-plan via PRICE_OVERRIDE env if needed.
CEREBRAS_PRICING: Final[dict[str, dict[str, float]]] = {
    "gpt-oss-120b": {
        "input_per_million_usd": 0.35,
        "output_per_million_usd": 0.75,
    },
}

_DEFAULT_BASE_URL: Final[str] = "https://api.cerebras.ai/v1"
_DEFAULT_MODEL: Final[str] = "gpt-oss-120b"
_RETRY_BACKOFF_SECONDS: Final[float] = 2.0
_REQUEST_TIMEOUT_SECONDS: Final[float] = 60.0


def _resolve_finish_reason(raw: str | None) -> FinishReason:
    """Map Cerebras finish strings to the benchmark's FinishReason union."""
    if raw == "tool_calls":
        return "tool_calls"
    if raw == "length":
        return "length"
    if raw == "content_filter":
        return "content_filter"
    if raw == "stop":
        return "stop"
    return "error"


def _compute_cost_usd(model: str, prompt_tokens: int, completion_tokens: int) -> float:
    """Compute USD cost for a Cerebras call. Returns 0.0 for unknown models."""
    pricing = CEREBRAS_PRICING.get(model)
    if pricing is None:
        return 0.0
    input_cost = (prompt_tokens / 1_000_000.0) * pricing["input_per_million_usd"]
    output_cost = (completion_tokens / 1_000_000.0) * pricing["output_per_million_usd"]
    return input_cost + output_cost


def _parse_tool_calls(raw_tool_calls: list[dict[str, Any]] | None) -> list[ToolCall]:
    """Parse OpenAI-format tool_calls into the benchmark ToolCall shape."""
    if not raw_tool_calls:
        return []
    parsed: list[ToolCall] = []
    for tc in raw_tool_calls:
        function = tc.get("function") or {}
        name = function.get("name")
        if not isinstance(name, str) or not name:
            raise ProviderError(
                "Cerebras tool_call missing function.name",
                status=None,
                body=json.dumps(tc),
                provider="cerebras",
            )
        raw_args = function.get("arguments", "{}")
        if isinstance(raw_args, str):
            arguments = json.loads(raw_args) if raw_args else {}
        elif isinstance(raw_args, dict):
            arguments = raw_args
        else:
            raise ProviderError(
                f"Cerebras tool_call arguments must be str or dict, got {type(raw_args).__name__}",
                status=None,
                body=json.dumps(tc),
                provider="cerebras",
            )
        if not isinstance(arguments, dict):
            raise ProviderError(
                "Cerebras tool_call arguments did not parse to dict",
                status=None,
                body=json.dumps(tc),
                provider="cerebras",
            )
        call_id = tc.get("id")
        if not isinstance(call_id, str) or not call_id:
            call_id = f"call_{len(parsed)}"
        parsed.append(ToolCall(id=call_id, name=name, arguments=arguments))
    return parsed


class CerebrasClient(BaseClient):
    """OpenAI-compatible client for the Cerebras inference API."""

    def __init__(
        self,
        model: str | None = None,
        api_key: str | None = None,
        base_url: str | None = None,
        *,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        resolved_key = api_key or os.environ.get("CEREBRAS_API_KEY", "").strip()
        if not resolved_key:
            raise ProviderError(
                "CEREBRAS_API_KEY is not set; required for CerebrasClient.",
                status=None,
                body=None,
                provider="cerebras",
            )
        self._api_key = resolved_key
        self._base_url = (base_url or os.environ.get("CEREBRAS_BASE_URL") or _DEFAULT_BASE_URL).rstrip(
            "/"
        )
        self.model_name = model or os.environ.get("CEREBRAS_MODEL") or _DEFAULT_MODEL
        self._http_client = http_client
        self._owns_http_client = http_client is None

    def _build_body(self, call: ClientCall) -> dict[str, Any]:
        body: dict[str, Any] = {
            "model": self.model_name,
            "messages": call.messages,
            "temperature": call.temperature,
            "parallel_tool_calls": False,
        }
        if call.tools:
            body["tools"] = call.tools
        if call.max_tokens is not None:
            # gpt-oss-style reasoning models bill reasoning tokens against this
            # cap; max_completion_tokens is the documented field name.
            body["max_completion_tokens"] = call.max_tokens
        if self.model_name.startswith("gpt-oss"):
            body["reasoning_effort"] = call.reasoning_effort
        if call.extra:
            body.update(call.extra)
        return body

    async def _post_once(
        self,
        client: httpx.AsyncClient,
        body: dict[str, Any],
    ) -> httpx.Response:
        return await client.post(
            f"{self._base_url}/chat/completions",
            headers={
                "Authorization": f"Bearer {self._api_key}",
                "Content-Type": "application/json",
            },
            content=json.dumps(body),
            timeout=_REQUEST_TIMEOUT_SECONDS,
        )

    async def complete(self, call: ClientCall) -> ClientResponse:
        body = self._build_body(call)
        client = self._http_client or httpx.AsyncClient()
        start_ns = time.perf_counter_ns()
        try:
            response = await self._post_once(client, body)
            if response.status_code == 429 or response.status_code >= 500:
                # Single retry on transient failures, with a fixed 2s backoff.
                # No more than one retry — fail loudly so the runner sees it.
                await asyncio.sleep(_RETRY_BACKOFF_SECONDS)
                response = await self._post_once(client, body)
            if response.status_code >= 400:
                raise ProviderError(
                    f"Cerebras error {response.status_code}",
                    status=response.status_code,
                    body=response.text[:500],
                    provider="cerebras",
                )
            data = response.json()
        finally:
            if self._owns_http_client:
                await client.aclose()
        latency_ms = (time.perf_counter_ns() - start_ns) // 1_000_000

        if not isinstance(data, dict):
            raise ProviderError(
                "Cerebras response was not a JSON object",
                status=None,
                body=str(data)[:500],
                provider="cerebras",
            )
        choices = data.get("choices") or []
        if not choices:
            raise ProviderError(
                "Cerebras response missing choices[0]",
                status=None,
                body=json.dumps(data)[:500],
                provider="cerebras",
            )
        choice = choices[0]
        message = choice.get("message") or {}
        content = message.get("content")
        if content is not None and not isinstance(content, str):
            raise ProviderError(
                "Cerebras choices[0].message.content was not a string",
                status=None,
                body=json.dumps(data)[:500],
                provider="cerebras",
            )
        tool_calls = _parse_tool_calls(message.get("tool_calls"))
        finish_reason = _resolve_finish_reason(choice.get("finish_reason"))

        usage_raw = data.get("usage") or {}
        prompt_tokens = int(usage_raw.get("prompt_tokens") or 0)
        completion_tokens = int(usage_raw.get("completion_tokens") or 0)
        total_tokens = int(usage_raw.get("total_tokens") or (prompt_tokens + completion_tokens))
        # Cerebras prompt caching (gpt-oss-120b): default-on, 128-token blocks.
        # Hit count surfaces at ``usage.prompt_tokens_details.cached_tokens``
        # using the same shape as OpenAI's documented response.
        prompt_details = usage_raw.get("prompt_tokens_details") or {}
        cached_tokens_raw = prompt_details.get("cached_tokens")
        cache_read_value: int | None = (
            int(cached_tokens_raw) if isinstance(cached_tokens_raw, (int, float)) else None
        )
        usage = Usage(
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            total_tokens=total_tokens,
            cached_tokens=cache_read_value if cache_read_value is not None else 0,
            cache_read_input_tokens=cache_read_value,
            # Cerebras does not bill a separate cache-creation tier — pass
            # through whatever the provider reports, else leave as None so
            # downstream consumers do not silently default to zero.
            cache_creation_input_tokens=None,
        )
        cost_usd = _compute_cost_usd(self.model_name, prompt_tokens, completion_tokens)

        return ClientResponse(
            content=content,
            tool_calls=tool_calls,
            finish_reason=finish_reason,
            usage=usage,
            latency_ms=int(latency_ms),
            cost_usd=cost_usd,
            raw_provider_response=data,
        )
