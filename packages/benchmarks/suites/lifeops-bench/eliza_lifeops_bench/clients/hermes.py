"""Hermes-template inference client.

Hermes / Nous-Hermes-3 models do **not** use OpenAI's native ``tool_calls``
field. They are trained with the Hermes function-calling template, which
embeds the tool catalogue inside the system prompt as ``<tools>{json}</tools>``
and emits each tool call as a ``<tool_call>{json}</tool_call>`` XML block in
the assistant's text response. Tool results are fed back as
``<tool_response>{...}</tool_response>``.

The system prompt below is taken verbatim from the upstream template at
https://github.com/NousResearch/Hermes-Function-Calling/blob/main/prompt_assets/sys_prompt.yml
(rev: main, fetched 2026-05-10), with placeholder substitution performed by
this client. Update the URL anchor when re-syncing.

The endpoint is OpenAI-compatible chat-completions (works with vLLM,
Together, OpenRouter, llama.cpp's openai-compat shim, etc.).
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import re
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

# Pricing: keyed by model id. Defaults are conservative placeholders; real
# operator should override based on their endpoint provider.
HERMES_PRICING: Final[dict[str, dict[str, float]]] = {
    "NousResearch/Hermes-3-Llama-3.1-70B": {
        "input_per_million_usd": 0.50,
        "output_per_million_usd": 0.50,
    },
}

_DEFAULT_MODEL: Final[str] = "NousResearch/Hermes-3-Llama-3.1-70B"
_RETRY_BACKOFF_SECONDS: Final[float] = 2.0
_REQUEST_TIMEOUT_ENV: Final[str] = "LIFEOPS_BENCH_HERMES_REQUEST_TIMEOUT_S"
_DEFAULT_REQUEST_TIMEOUT_SECONDS: Final[float] = 300.0
_MIN_REQUEST_TIMEOUT_SECONDS: Final[float] = 1.0
_MAX_REQUEST_TIMEOUT_SECONDS: Final[float] = 3600.0

# Verbatim from prompt_assets/sys_prompt.yml (Role + Objective + Tools +
# Instructions sections, joined with blank lines). Keep this string aligned
# with upstream — when re-syncing, copy the YAML scalar values exactly.
_HERMES_SYSTEM_TEMPLATE: Final[str] = (
    "You are a function calling AI agent with self-recursion.\n"
    "You can call only one function at a time and analyse data you get from "
    "function response.\n"
    "You are provided with function signatures within <tools></tools> XML tags.\n"
    "\n"
    "You may use agentic frameworks for reasoning and planning to help with "
    "user query.\n"
    "Please call a function and wait for function results to be provided to "
    "you in the next iteration.\n"
    "Don't make assumptions about what values to plug into function arguments.\n"
    "Once you have called a function, results will be fed back to you within "
    "<tool_response></tool_response> XML tags.\n"
    "Don't make assumptions about tool results if <tool_response> XML tags "
    "are not present since function hasn't been executed yet.\n"
    "Analyze the data once you get the results and call another function.\n"
    "\n"
    "Here are the available tools:\n"
    "<tools> {tools_json} </tools>\n"
    "\n"
    "For each function call return a valid json object (using double quotes) "
    "with function name and arguments within <tool_call></tool_call> XML "
    "tags as follows:\n"
    "<tool_call>\n"
    '{{"name": <function-name>, "arguments": <args-dict>}}\n'
    "</tool_call>"
)

_TOOL_CALL_RE: Final[re.Pattern[str]] = re.compile(
    r"<tool_call>\s*(\{.*?\})\s*</tool_call>",
    re.DOTALL,
)


def resolve_hermes_request_timeout_s(
    value: float | str | None = None,
) -> float:
    """Resolve and validate the wall-clock limit for one Hermes HTTP request.

    Explicit values (including the CLI flag) win over
    ``LIFEOPS_BENCH_HERMES_REQUEST_TIMEOUT_S``. The upper bound prevents a
    dead local endpoint from occupying a worker indefinitely; the benchmark's
    per-scenario timeout remains the outer limit across multiple requests.
    """
    raw: float | str = (
        value
        if value is not None
        else (
            os.environ.get(_REQUEST_TIMEOUT_ENV, "").strip()
            or _DEFAULT_REQUEST_TIMEOUT_SECONDS
        )
    )
    if isinstance(raw, bool):
        raise ValueError("Hermes request timeout must be a number of seconds")
    try:
        timeout_s = float(raw)
    # error-policy:J3 Invalid operator input produces an explicit config failure.
    except (TypeError, ValueError) as exc:
        raise ValueError("Hermes request timeout must be a number of seconds") from exc
    if (
        not math.isfinite(timeout_s)
        or timeout_s < _MIN_REQUEST_TIMEOUT_SECONDS
        or timeout_s > _MAX_REQUEST_TIMEOUT_SECONDS
    ):
        raise ValueError(
            "Hermes request timeout must be between "
            f"{_MIN_REQUEST_TIMEOUT_SECONDS:g} and "
            f"{_MAX_REQUEST_TIMEOUT_SECONDS:g} seconds"
        )
    return timeout_s


def _coerce_arguments_object(raw: Any, *, raw_block: str) -> dict[str, Any]:
    """Normalize tool-call arguments into a JSON object."""
    if isinstance(raw, str):
        if not raw:
            return {}
        try:
            # strict=False for the same reason as the block decoder: literal
            # control characters inside multiline string arguments are common
            # from small models and do not make the payload meaningless.
            raw = json.loads(raw, strict=False)
        except json.JSONDecodeError as exc:
            raise ProviderError(
                "Hermes <tool_call> arguments string was not valid JSON",
                status=None,
                body=raw_block,
                provider="hermes",
            ) from exc
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise ProviderError(
            "Hermes <tool_call> arguments was not a dict",
            status=None,
            body=raw_block,
            provider="hermes",
        )
    return raw


def _payload_name_and_arguments(
    payload: dict[str, Any], *, raw_block: str
) -> tuple[str, dict[str, Any]]:
    """Accept common Hermes/OpenAI-compatible tool-call payload variants."""
    name = payload.get("name")
    if not isinstance(name, str) or not name:
        name = payload.get("tool")
    if not isinstance(name, str) or not name:
        function = payload.get("function")
        if isinstance(function, dict):
            name = function.get("name")
    if not isinstance(name, str) or not name:
        raise ProviderError(
            "Hermes <tool_call> missing 'name'",
            status=None,
            body=raw_block,
            provider="hermes",
        )

    if "arguments" in payload:
        raw_arguments = payload.get("arguments")
    elif "args" in payload:
        raw_arguments = payload.get("args")
    elif "parameters" in payload:
        raw_arguments = payload.get("parameters")
    else:
        raw_arguments = {}
    return name, _coerce_arguments_object(raw_arguments, raw_block=raw_block)


def _build_hermes_system_prompt(tools: list[dict[str, Any]] | None) -> str:
    """Render the Hermes system prompt, embedding the OpenAI tools list."""
    tools_payload: list[dict[str, Any]] = []
    if tools:
        for tool in tools:
            # Hermes models were trained on raw OpenAI-format tool dicts —
            # send the function block, not the wrapper.
            function = tool.get("function") or tool
            tools_payload.append(function)
    tools_json = json.dumps(tools_payload, separators=(",", ":"))
    return _HERMES_SYSTEM_TEMPLATE.format(tools_json=tools_json)


def _convert_messages_to_hermes(
    messages: list[dict[str, Any]],
) -> tuple[str | None, list[dict[str, Any]]]:
    """Convert OpenAI-shaped messages to Hermes-friendly chat-completions form.

    - tool-role messages → user-role text with ``<tool_response>{...}</tool_response>``
    - assistant ``tool_calls`` → assistant text with ``<tool_call>{...}</tool_call>``
    - user-supplied system message is extracted and concatenated separately
      so the caller can prepend the Hermes template.
    """
    user_system_parts: list[str] = []
    rest: list[dict[str, Any]] = []
    for msg in messages:
        role = msg.get("role")
        if role == "system":
            content = msg.get("content")
            if isinstance(content, str) and content:
                user_system_parts.append(content)
            continue
        if role == "tool":
            content = msg.get("content")
            content_str = content if isinstance(content, str) else json.dumps(content)
            tool_call_id = msg.get("tool_call_id")
            response_payload: dict[str, Any] = {"content": content_str}
            if isinstance(tool_call_id, str):
                response_payload["tool_call_id"] = tool_call_id
            rest.append(
                {
                    "role": "user",
                    "content": f"<tool_response>{json.dumps(response_payload, separators=(',', ':'))}</tool_response>",
                }
            )
            continue
        if role == "assistant":
            text_content = msg.get("content") or ""
            tool_calls = msg.get("tool_calls") or []
            rendered_calls: list[str] = []
            for tc in tool_calls:
                function = tc.get("function") or {}
                name = function.get("name") or ""
                arguments_raw = function.get("arguments")
                arguments = _coerce_arguments_object(
                    arguments_raw,
                    raw_block=json.dumps(tc),
                )
                payload = json.dumps(
                    {"name": name, "arguments": arguments},
                    separators=(",", ":"),
                )
                rendered_calls.append(f"<tool_call>{payload}</tool_call>")
            assistant_text = (
                text_content
                + ("\n" if text_content and rendered_calls else "")
                + "\n".join(rendered_calls)
            )
            rest.append({"role": "assistant", "content": assistant_text})
            continue
        if role == "user":
            content = msg.get("content")
            rest.append(
                {"role": "user", "content": content if content is not None else ""}
            )
            continue
        raise ProviderError(
            f"Unsupported message role for Hermes: {role!r}",
            status=None,
            body=str(msg),
            provider="hermes",
        )
    user_system = "\n\n".join(user_system_parts) if user_system_parts else None
    return user_system, rest


def _decode_tool_call_payloads(raw: str, *, raw_block: str) -> list[dict[str, Any]]:
    """Decode every consecutive JSON object inside one ``<tool_call>`` span.

    Hermes-template models — especially small local ones — routinely concatenate
    two complete call objects, ``{...}{...}`` or newline-separated, inside a
    single block. Each is a call the model genuinely emitted, so a strict single
    ``json.loads`` (which raises ``Extra data``) would abort an entire scenario
    over well-formed output. Objects are therefore decoded front-to-back.

    ``strict=False`` accepts literal control characters inside string values;
    the same models emit raw newlines in multiline arguments. Strictness is kept
    where it protects meaning: an undecodable *first* value still raises, and
    trailing residue is dropped only once at least one object has parsed. The
    verbatim response text is preserved upstream in the turn artifact, so
    nothing salvaged here is hidden from review.
    """
    decoder = json.JSONDecoder(strict=False)
    payloads: list[dict[str, Any]] = []
    pos = 0
    length = len(raw)
    while pos < length:
        while pos < length and raw[pos].isspace():
            pos += 1
        if pos >= length:
            break
        try:
            value, end = decoder.raw_decode(raw, pos)
        except json.JSONDecodeError as exc:
            if payloads:
                break
            raise ProviderError(
                "Hermes <tool_call> block was not valid JSON",
                status=None,
                body=raw_block,
                provider="hermes",
            ) from exc
        if not isinstance(value, dict):
            # The block regex anchors the span on `{`, so the first decoded
            # value is always an object; a later non-object value is residue.
            break
        payloads.append(value)
        pos = end
    if not payloads:
        raise ProviderError(
            "Hermes <tool_call> payload was not a JSON object",
            status=None,
            body=raw_block,
            provider="hermes",
        )
    return payloads


def _parse_hermes_response_text(
    text: str,
    *,
    call_id_prefix: str = "call",
) -> tuple[str | None, list[ToolCall]]:
    """Extract ``<tool_call>`` blocks; return (prose_without_calls, parsed_calls)."""
    parsed: list[ToolCall] = []
    matches = list(_TOOL_CALL_RE.finditer(text))
    for match in matches:
        for payload in _decode_tool_call_payloads(
            match.group(1), raw_block=match.group(0)
        ):
            name, arguments = _payload_name_and_arguments(
                payload, raw_block=match.group(0)
            )
            parsed.append(
                ToolCall(
                    id=f"{call_id_prefix}_{len(parsed)}",
                    name=name,
                    arguments=arguments,
                )
            )
    if parsed:
        prose = _TOOL_CALL_RE.sub("", text).strip()
        return (prose if prose else None), parsed
    return text, []


def _compute_cost_usd(
    model: str, prompt_tokens: int, completion_tokens: int
) -> float | None:
    """Compute USD cost for a Hermes call.

    Returns :data:`None` when ``model`` is not in :data:`HERMES_PRICING` —
    per AGENTS.md Cmd #8 an unpriced model stays nullable, not a silent
    free ``0.0``. Operators hosting non-default Hermes variants should
    extend ``HERMES_PRICING`` rather than rely on a fallback.
    """
    pricing = HERMES_PRICING.get(model)
    if pricing is None:
        return None
    return (
        prompt_tokens / 1_000_000.0 * pricing["input_per_million_usd"]
        + completion_tokens / 1_000_000.0 * pricing["output_per_million_usd"]
    )


class HermesClient(BaseClient):
    """OpenAI-compat client for Hermes-template models (vLLM/Together/etc)."""

    def __init__(
        self,
        model: str | None = None,
        api_key: str | None = None,
        base_url: str | None = None,
        *,
        request_timeout_s: float | str | None = None,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        resolved_base = base_url or os.environ.get("HERMES_BASE_URL", "").strip()
        if not resolved_base:
            raise ProviderError(
                "HERMES_BASE_URL is not set; required for HermesClient.",
                status=None,
                body=None,
                provider="hermes",
            )
        self._base_url = resolved_base.rstrip("/")
        self._api_key = api_key or os.environ.get("HERMES_API_KEY", "")
        self.model_name = model or os.environ.get("HERMES_MODEL") or _DEFAULT_MODEL
        self.request_timeout_s = resolve_hermes_request_timeout_s(request_timeout_s)
        self._http_client = http_client
        self._owns_http_client = http_client is None
        self._request_ordinal = 0

    def _build_messages(
        self,
        call: ClientCall,
    ) -> list[dict[str, Any]]:
        user_system, rest = _convert_messages_to_hermes(call.messages)
        if not call.enable_tool_protocol:
            return (
                rest
                if user_system is None
                else [{"role": "system", "content": user_system}, *rest]
            )
        hermes_system = _build_hermes_system_prompt(call.tools)
        merged_system = (
            hermes_system
            if user_system is None
            else f"{hermes_system}\n\n{user_system}"
        )
        return [{"role": "system", "content": merged_system}, *rest]

    def _build_body(self, call: ClientCall) -> dict[str, Any]:
        body: dict[str, Any] = {
            "model": self.model_name,
            "messages": self._build_messages(call),
            "temperature": call.temperature,
        }
        if call.max_tokens is not None:
            body["max_tokens"] = call.max_tokens
        if call.extra:
            body.update(call.extra)
        return body

    async def _post_once(
        self,
        client: httpx.AsyncClient,
        body: dict[str, Any],
    ) -> httpx.Response:
        headers: dict[str, str] = {"Content-Type": "application/json"}
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
        try:
            return await client.post(
                f"{self._base_url}/chat/completions",
                headers=headers,
                content=json.dumps(body),
                timeout=self.request_timeout_s,
            )
        # error-policy:J1 Translate transport timeouts at the provider boundary.
        except httpx.TimeoutException as exc:
            raise ProviderError(
                f"Hermes request timed out after {self.request_timeout_s:g} seconds",
                status=None,
                body=None,
                provider="hermes",
            ) from exc
        # error-policy:J1 Expose other transport failures without fabricating output.
        except httpx.RequestError as exc:
            raise ProviderError(
                f"Hermes transport failed: {type(exc).__name__}: {exc}",
                status=None,
                body=None,
                provider="hermes",
            ) from exc

    async def complete(self, call: ClientCall) -> ClientResponse:
        body = self._build_body(call)
        client = self._http_client or httpx.AsyncClient()
        # Text-template providers do not supply native tool-call IDs. A
        # client-local request ordinal keeps every synthesized ID distinct
        # across a multi-turn run, including concurrent calls.
        self._request_ordinal += 1
        call_id_prefix = f"call_{self._request_ordinal}"
        start_ns = time.perf_counter_ns()
        try:
            response = await self._post_once(client, body)
            if response.status_code == 429 or response.status_code >= 500:
                await asyncio.sleep(_RETRY_BACKOFF_SECONDS)
                response = await self._post_once(client, body)
            if response.status_code >= 400:
                raise ProviderError(
                    f"Hermes endpoint error {response.status_code}",
                    status=response.status_code,
                    body=response.text[:500],
                    provider="hermes",
                )
            try:
                data = response.json()
            # error-policy:J1 An incomplete provider body is a failed call, not a turn.
            except json.JSONDecodeError as exc:
                raise ProviderError(
                    "Hermes response was not valid JSON",
                    status=response.status_code,
                    body=response.text[:500],
                    provider="hermes",
                ) from exc
        finally:
            if self._owns_http_client:
                await client.aclose()
        latency_ms = (time.perf_counter_ns() - start_ns) // 1_000_000

        if not isinstance(data, dict):
            raise ProviderError(
                "Hermes response was not a JSON object",
                status=None,
                body=str(data)[:500],
                provider="hermes",
            )
        choices = data.get("choices") or []
        if not choices:
            raise ProviderError(
                "Hermes response missing choices[0]",
                status=None,
                body=json.dumps(data)[:500],
                provider="hermes",
            )
        choice = choices[0]
        message = choice.get("message") or {}
        raw_text = message.get("content") or ""
        if not isinstance(raw_text, str):
            raise ProviderError(
                "Hermes choices[0].message.content was not a string",
                status=None,
                body=json.dumps(data)[:500],
                provider="hermes",
            )
        content, tool_calls = _parse_hermes_response_text(
            raw_text,
            call_id_prefix=call_id_prefix,
        )
        finish_reason: FinishReason = "tool_calls" if tool_calls else "stop"

        usage_raw = data.get("usage") or {}
        prompt_tokens = int(usage_raw.get("prompt_tokens") or 0)
        completion_tokens = int(usage_raw.get("completion_tokens") or 0)
        total_tokens = int(
            usage_raw.get("total_tokens") or (prompt_tokens + completion_tokens)
        )
        # Hermes-template OpenAI-compat servers (vLLM / Together) surface cache
        # hits the same way OpenAI does when caching is enabled upstream.
        prompt_details = usage_raw.get("prompt_tokens_details") or {}
        cached_tokens_raw = prompt_details.get("cached_tokens")
        cache_read_value: int | None = (
            int(cached_tokens_raw)
            if isinstance(cached_tokens_raw, (int, float))
            else None
        )
        usage = Usage(
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            total_tokens=total_tokens,
            cached_tokens=cache_read_value if cache_read_value is not None else 0,
            cache_read_input_tokens=cache_read_value,
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
