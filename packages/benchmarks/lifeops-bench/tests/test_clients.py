"""Unit tests for the inference client wrappers.

The non-live tests use ``httpx.MockTransport`` (Cerebras + Hermes) and a
hand-rolled fake SDK object (Anthropic) so we never touch the network unless
``LIFEOPS_BENCH_LIVE=1``.
"""

from __future__ import annotations

import json
import os
from typing import Any

import httpx
import pytest

from eliza_lifeops_bench.clients import (
    ANTHROPIC_PRICING,
    AnthropicClient,
    BaseClient,
    CEREBRAS_PRICING,
    CerebrasClient,
    ClientCall,
    ClientResponse,
    HERMES_PRICING,
    HermesClient,
    ProviderError,
    ToolCall,
    Usage,
    make_client,
)
from eliza_lifeops_bench.clients.hermes import (
    _build_hermes_system_prompt,
    _parse_hermes_response_text,
)


# ---------------------------------------------------------------------------
# Cerebras
# ---------------------------------------------------------------------------


def _cerebras_success_response() -> dict[str, Any]:
    return {
        "id": "chatcmpl-test",
        "model": "gpt-oss-120b",
        "choices": [
            {
                "index": 0,
                "finish_reason": "tool_calls",
                "message": {
                    "role": "assistant",
                    "content": "I will check your calendar.",
                    "tool_calls": [
                        {
                            "id": "call_abc",
                            "type": "function",
                            "function": {
                                "name": "list_events",
                                "arguments": json.dumps({"date": "2026-05-10"}),
                            },
                        }
                    ],
                },
            }
        ],
        "usage": {
            "prompt_tokens": 100,
            "completion_tokens": 25,
            "total_tokens": 125,
            "prompt_tokens_details": {"cached_tokens": 10},
        },
    }


def _make_transport_recording_body(
    response_payload: dict[str, Any],
    *,
    captured_request_body: list[dict[str, Any]],
    status_codes: list[int] | None = None,
) -> httpx.MockTransport:
    statuses = list(status_codes) if status_codes else [200]
    call_index = {"i": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        captured_request_body.append(json.loads(request.content.decode("utf-8")))
        i = call_index["i"]
        call_index["i"] += 1
        status = statuses[min(i, len(statuses) - 1)]
        if status == 200:
            return httpx.Response(200, json=response_payload)
        return httpx.Response(status, text=f"simulated {status}")

    return httpx.MockTransport(handler)


@pytest.mark.asyncio
async def test_cerebras_complete_parses_tool_calls_and_usage() -> None:
    captured: list[dict[str, Any]] = []
    transport = _make_transport_recording_body(
        _cerebras_success_response(), captured_request_body=captured
    )
    async with httpx.AsyncClient(transport=transport) as http_client:
        client = CerebrasClient(
            api_key="sk-test",
            model="gpt-oss-120b",
            http_client=http_client,
        )
        response = await client.complete(
            ClientCall(
                messages=[{"role": "user", "content": "what's on my schedule"}],
                tools=[
                    {
                        "type": "function",
                        "function": {
                            "name": "list_events",
                            "description": "list calendar events",
                            "parameters": {"type": "object", "properties": {}},
                        },
                    }
                ],
                temperature=0.0,
                max_tokens=512,
                reasoning_effort="low",
            )
        )

    assert isinstance(response, ClientResponse)
    assert response.content == "I will check your calendar."
    assert response.finish_reason == "tool_calls"
    assert len(response.tool_calls) == 1
    assert response.tool_calls[0] == ToolCall(
        id="call_abc",
        name="list_events",
        arguments={"date": "2026-05-10"},
    )
    assert response.usage == Usage(
        prompt_tokens=100,
        completion_tokens=25,
        total_tokens=125,
        cached_tokens=10,
        cache_read_input_tokens=10,
        cache_creation_input_tokens=None,
    )
    expected_cost = (100 / 1_000_000) * CEREBRAS_PRICING["gpt-oss-120b"][
        "input_per_million_usd"
    ] + (25 / 1_000_000) * CEREBRAS_PRICING["gpt-oss-120b"]["output_per_million_usd"]
    assert response.cost_usd == pytest.approx(expected_cost)

    # Verify wire format
    assert len(captured) == 1
    body = captured[0]
    assert body["model"] == "gpt-oss-120b"
    assert body["parallel_tool_calls"] is False
    assert body["reasoning_effort"] == "low"
    assert body["max_completion_tokens"] == 512
    assert body["temperature"] == 0.0
    assert "tools" in body


@pytest.mark.asyncio
async def test_cerebras_retries_once_on_429() -> None:
    captured: list[dict[str, Any]] = []
    transport = _make_transport_recording_body(
        _cerebras_success_response(),
        captured_request_body=captured,
        status_codes=[429, 200],
    )
    async with httpx.AsyncClient(transport=transport) as http_client:
        client = CerebrasClient(
            api_key="sk-test", model="gpt-oss-120b", http_client=http_client
        )
        # Patch the fixed sleep to be instant for the test
        import eliza_lifeops_bench.clients.cerebras as cerebras_mod

        original_sleep = cerebras_mod.asyncio.sleep

        async def _no_sleep(_seconds: float) -> None:
            return None

        cerebras_mod.asyncio.sleep = _no_sleep  # type: ignore[assignment]
        try:
            response = await client.complete(
                ClientCall(messages=[{"role": "user", "content": "hi"}])
            )
        finally:
            cerebras_mod.asyncio.sleep = original_sleep  # type: ignore[assignment]

    assert response.finish_reason == "tool_calls"
    assert len(captured) == 2  # one retry


@pytest.mark.asyncio
async def test_cerebras_raises_provider_error_after_second_5xx() -> None:
    captured: list[dict[str, Any]] = []
    transport = _make_transport_recording_body(
        _cerebras_success_response(),
        captured_request_body=captured,
        status_codes=[500, 500],
    )
    async with httpx.AsyncClient(transport=transport) as http_client:
        client = CerebrasClient(
            api_key="sk-test", model="gpt-oss-120b", http_client=http_client
        )
        import eliza_lifeops_bench.clients.cerebras as cerebras_mod

        original_sleep = cerebras_mod.asyncio.sleep

        async def _no_sleep(_seconds: float) -> None:
            return None

        cerebras_mod.asyncio.sleep = _no_sleep  # type: ignore[assignment]
        try:
            with pytest.raises(ProviderError) as exc_info:
                await client.complete(
                    ClientCall(messages=[{"role": "user", "content": "hi"}])
                )
        finally:
            cerebras_mod.asyncio.sleep = original_sleep  # type: ignore[assignment]

    assert exc_info.value.status == 500
    assert exc_info.value.provider == "cerebras"
    assert len(captured) == 2  # one retry, then bail


def test_cerebras_requires_api_key() -> None:
    saved = os.environ.pop("CEREBRAS_API_KEY", None)
    try:
        with pytest.raises(ProviderError):
            CerebrasClient()
    finally:
        if saved is not None:
            os.environ["CEREBRAS_API_KEY"] = saved


# ---------------------------------------------------------------------------
# Anthropic
# ---------------------------------------------------------------------------


class _FakeAnthropicResponse:
    """Mimics the SDK's Message object's ``model_dump()`` surface."""

    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload

    def model_dump(self) -> dict[str, Any]:
        return self._payload


class _FakeAnthropicMessages:
    def __init__(
        self,
        responses: list[dict[str, Any]],
        *,
        captured: list[dict[str, Any]],
    ) -> None:
        self._responses = list(responses)
        self._captured = captured
        self._call_index = 0

    async def create(self, **kwargs: Any) -> _FakeAnthropicResponse:
        self._captured.append(kwargs)
        payload = self._responses[min(self._call_index, len(self._responses) - 1)]
        self._call_index += 1
        return _FakeAnthropicResponse(payload)


class _FakeAnthropicClient:
    def __init__(
        self,
        responses: list[dict[str, Any]],
        *,
        captured: list[dict[str, Any]],
    ) -> None:
        self.messages = _FakeAnthropicMessages(responses, captured=captured)


def _anthropic_text_response() -> dict[str, Any]:
    return {
        "id": "msg_test",
        "type": "message",
        "role": "assistant",
        "content": [{"type": "text", "text": "Yes, you have a meeting at 3pm."}],
        "stop_reason": "end_turn",
        "stop_sequence": None,
        "usage": {
            "input_tokens": 200,
            "output_tokens": 50,
            "cache_read_input_tokens": 0,
        },
    }


def _anthropic_tool_use_response() -> dict[str, Any]:
    return {
        "id": "msg_test_tool",
        "type": "message",
        "role": "assistant",
        "content": [
            {"type": "text", "text": "Let me check."},
            {
                "type": "tool_use",
                "id": "toolu_01abc",
                "name": "list_events",
                "input": {"date": "2026-05-10"},
            },
        ],
        "stop_reason": "tool_use",
        "usage": {
            "input_tokens": 150,
            "output_tokens": 30,
            "cache_read_input_tokens": 50,
        },
    }


@pytest.mark.asyncio
async def test_anthropic_text_response_parses_usage_and_pricing() -> None:
    captured: list[dict[str, Any]] = []
    fake = _FakeAnthropicClient([_anthropic_text_response()], captured=captured)
    client = AnthropicClient(model="claude-opus-4-7", client=fake)
    response = await client.complete(
        ClientCall(
            messages=[
                {"role": "system", "content": "be concise"},
                {"role": "user", "content": "any meetings?"},
            ],
            temperature=0.0,
            max_tokens=1024,
        )
    )
    assert response.content == "Yes, you have a meeting at 3pm."
    assert response.tool_calls == []
    assert response.finish_reason == "stop"
    assert response.usage == Usage(
        prompt_tokens=200,
        completion_tokens=50,
        total_tokens=250,
        cached_tokens=0,
        cache_read_input_tokens=0,
        cache_creation_input_tokens=None,
    )
    pricing = ANTHROPIC_PRICING["claude-opus-4-7"]
    expected = (
        200 / 1_000_000 * pricing["input_per_million_usd"]
        + 50 / 1_000_000 * pricing["output_per_million_usd"]
    )
    assert response.cost_usd == pytest.approx(expected)
    # System message split out, not in messages
    assert captured[0]["system"] == "be concise"
    assert all(m["role"] != "system" for m in captured[0]["messages"])


@pytest.mark.asyncio
async def test_anthropic_tool_use_extracts_tool_call_and_cache() -> None:
    captured: list[dict[str, Any]] = []
    fake = _FakeAnthropicClient([_anthropic_tool_use_response()], captured=captured)
    client = AnthropicClient(model="claude-opus-4-7", client=fake)
    response = await client.complete(
        ClientCall(
            messages=[{"role": "user", "content": "any meetings?"}],
            tools=[
                {
                    "type": "function",
                    "function": {
                        "name": "list_events",
                        "description": "list events",
                        "parameters": {"type": "object", "properties": {}},
                    },
                }
            ],
        )
    )
    assert response.content == "Let me check."
    assert response.finish_reason == "tool_calls"
    assert response.tool_calls == [
        ToolCall(id="toolu_01abc", name="list_events", arguments={"date": "2026-05-10"})
    ]
    assert response.usage.cached_tokens == 50
    pricing = ANTHROPIC_PRICING["claude-opus-4-7"]
    billable_input = 150 - 50
    expected = (
        billable_input / 1_000_000 * pricing["input_per_million_usd"]
        + 30 / 1_000_000 * pricing["output_per_million_usd"]
        + 50 / 1_000_000 * pricing["cache_read_per_million_usd"]
    )
    assert response.cost_usd == pytest.approx(expected)
    # Tools converted to Anthropic format
    assert captured[0]["tools"] == [
        {
            "name": "list_events",
            "description": "list events",
            "input_schema": {"type": "object", "properties": {}},
        }
    ]


@pytest.mark.asyncio
async def test_anthropic_retries_once_on_429() -> None:
    import anthropic as _anthropic_sdk

    class _Failing429:
        async def create(self, **_: Any) -> Any:
            raise _anthropic_sdk.APIStatusError(
                "rate limited",
                response=httpx.Response(429, request=httpx.Request("POST", "https://x")),
                body=None,
            )

    class _SuccessThen:
        def __init__(self) -> None:
            self.calls = 0

        async def create(self, **_: Any) -> Any:
            self.calls += 1
            if self.calls == 1:
                raise _anthropic_sdk.APIStatusError(
                    "rate limited",
                    response=httpx.Response(
                        429, request=httpx.Request("POST", "https://x")
                    ),
                    body=None,
                )
            return _FakeAnthropicResponse(_anthropic_text_response())

    class _FakeOuter:
        def __init__(self) -> None:
            self.messages = _SuccessThen()

    fake = _FakeOuter()
    client = AnthropicClient(model="claude-opus-4-7", client=fake)
    import eliza_lifeops_bench.clients.anthropic as anthropic_mod

    original_sleep = anthropic_mod.asyncio.sleep

    async def _no_sleep(_seconds: float) -> None:
        return None

    anthropic_mod.asyncio.sleep = _no_sleep  # type: ignore[assignment]
    try:
        response = await client.complete(
            ClientCall(messages=[{"role": "user", "content": "hi"}])
        )
    finally:
        anthropic_mod.asyncio.sleep = original_sleep  # type: ignore[assignment]
    assert response.finish_reason == "stop"
    assert fake.messages.calls == 2


# ---------------------------------------------------------------------------
# Hermes
# ---------------------------------------------------------------------------


def _hermes_response(text: str) -> dict[str, Any]:
    return {
        "id": "chatcmpl-hermes",
        "model": "NousResearch/Hermes-3-Llama-3.1-70B",
        "choices": [
            {
                "index": 0,
                "finish_reason": "stop",
                "message": {"role": "assistant", "content": text},
            }
        ],
        "usage": {
            "prompt_tokens": 80,
            "completion_tokens": 40,
            "total_tokens": 120,
        },
    }


def test_hermes_system_prompt_embeds_tools_json() -> None:
    tools = [
        {
            "type": "function",
            "function": {
                "name": "list_events",
                "description": "list events",
                "parameters": {"type": "object", "properties": {}},
            },
        }
    ]
    prompt = _build_hermes_system_prompt(tools)
    assert "<tools>" in prompt
    assert "</tools>" in prompt
    assert "list_events" in prompt
    assert "<tool_call>" in prompt
    # The function-block (not the wrapper) is what gets embedded
    assert '"type":"function"' not in prompt


def test_hermes_parses_zero_tool_calls() -> None:
    text = "Just a plain reply with no tools."
    content, calls = _parse_hermes_response_text(text)
    assert content == text
    assert calls == []


def test_hermes_parses_one_tool_call() -> None:
    text = (
        'Sure, checking now.\n<tool_call>{"name": "list_events", '
        '"arguments": {"date": "2026-05-10"}}</tool_call>'
    )
    content, calls = _parse_hermes_response_text(text)
    assert content == "Sure, checking now."
    assert calls == [
        ToolCall(id="call_0", name="list_events", arguments={"date": "2026-05-10"})
    ]


def test_hermes_parses_multiple_tool_calls() -> None:
    text = (
        '<tool_call>{"name": "list_events", "arguments": {"date": "2026-05-10"}}</tool_call>'
        '\n<tool_call>{"name": "list_events", "arguments": {"date": "2026-05-11"}}</tool_call>'
    )
    content, calls = _parse_hermes_response_text(text)
    assert content is None
    assert len(calls) == 2
    assert calls[0].id == "call_0"
    assert calls[1].id == "call_1"
    assert calls[0].arguments == {"date": "2026-05-10"}
    assert calls[1].arguments == {"date": "2026-05-11"}


@pytest.mark.asyncio
async def test_hermes_complete_full_pipeline() -> None:
    captured: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(json.loads(request.content.decode("utf-8")))
        return httpx.Response(
            200,
            json=_hermes_response(
                'OK\n<tool_call>{"name": "list_events", "arguments": {"date": "2026-05-10"}}</tool_call>'
            ),
        )

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as http_client:
        client = HermesClient(
            base_url="https://hermes.example.com/v1",
            api_key="sk-hermes",
            model="NousResearch/Hermes-3-Llama-3.1-70B",
            http_client=http_client,
        )
        response = await client.complete(
            ClientCall(
                messages=[
                    {"role": "system", "content": "be helpful"},
                    {"role": "user", "content": "list events for today"},
                ],
                tools=[
                    {
                        "type": "function",
                        "function": {
                            "name": "list_events",
                            "description": "list events",
                            "parameters": {"type": "object", "properties": {}},
                        },
                    }
                ],
                max_tokens=512,
            )
        )

    assert response.content == "OK"
    assert response.finish_reason == "tool_calls"
    assert response.tool_calls == [
        ToolCall(id="call_0", name="list_events", arguments={"date": "2026-05-10"})
    ]
    assert response.usage == Usage(
        prompt_tokens=80, completion_tokens=40, total_tokens=120, cached_tokens=0
    )
    pricing = HERMES_PRICING["NousResearch/Hermes-3-Llama-3.1-70B"]
    expected = (
        80 / 1_000_000 * pricing["input_per_million_usd"]
        + 40 / 1_000_000 * pricing["output_per_million_usd"]
    )
    assert response.cost_usd == pytest.approx(expected)

    # Wire format: no `tools` field; system message is hermes-template merged
    # with the user-supplied "be helpful".
    body = captured[0]
    assert "tools" not in body
    assert body["max_tokens"] == 512
    system_msg = body["messages"][0]
    assert system_msg["role"] == "system"
    assert "<tools>" in system_msg["content"]
    assert "be helpful" in system_msg["content"]


@pytest.mark.asyncio
async def test_hermes_retries_once_on_429() -> None:
    statuses = [429, 200]
    call_index = {"i": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        i = call_index["i"]
        call_index["i"] += 1
        if statuses[i] == 200:
            return httpx.Response(200, json=_hermes_response("done"))
        return httpx.Response(429, text="rate limited")

    transport = httpx.MockTransport(handler)
    import eliza_lifeops_bench.clients.hermes as hermes_mod

    original_sleep = hermes_mod.asyncio.sleep

    async def _no_sleep(_seconds: float) -> None:
        return None

    hermes_mod.asyncio.sleep = _no_sleep  # type: ignore[assignment]
    try:
        async with httpx.AsyncClient(transport=transport) as http_client:
            client = HermesClient(
                base_url="https://hermes.example.com/v1",
                http_client=http_client,
            )
            response = await client.complete(
                ClientCall(messages=[{"role": "user", "content": "hi"}])
            )
    finally:
        hermes_mod.asyncio.sleep = original_sleep  # type: ignore[assignment]
    assert response.finish_reason == "stop"
    assert call_index["i"] == 2


def test_hermes_requires_base_url() -> None:
    saved = os.environ.pop("HERMES_BASE_URL", None)
    try:
        with pytest.raises(ProviderError):
            HermesClient()
    finally:
        if saved is not None:
            os.environ["HERMES_BASE_URL"] = saved


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------


def test_make_client_unknown_provider_raises() -> None:
    with pytest.raises(ValueError):
        make_client("not-a-real-provider")


def test_make_client_returns_correct_subclass() -> None:
    # Use explicit env vars so the factory can construct the client without a
    # real network. We don't call .complete() — just verify subclass identity.
    saved_cerebras = os.environ.get("CEREBRAS_API_KEY")
    saved_anthropic = os.environ.get("ANTHROPIC_API_KEY")
    saved_hermes = os.environ.get("HERMES_BASE_URL")
    os.environ["CEREBRAS_API_KEY"] = "sk-test"
    os.environ["ANTHROPIC_API_KEY"] = "sk-test"
    os.environ["HERMES_BASE_URL"] = "https://hermes.example.com/v1"
    try:
        cerebras = make_client("cerebras")
        anthropic = make_client("anthropic")
        hermes = make_client("hermes")
        assert isinstance(cerebras, CerebrasClient)
        assert isinstance(anthropic, AnthropicClient)
        assert isinstance(hermes, HermesClient)
        assert isinstance(cerebras, BaseClient)
    finally:
        for name, value in (
            ("CEREBRAS_API_KEY", saved_cerebras),
            ("ANTHROPIC_API_KEY", saved_anthropic),
            ("HERMES_BASE_URL", saved_hermes),
        ):
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


# ---------------------------------------------------------------------------
# Live test (skipped unless LIFEOPS_BENCH_LIVE=1)
# ---------------------------------------------------------------------------


@pytest.mark.skipif(
    os.environ.get("LIFEOPS_BENCH_LIVE") != "1",
    reason="LIFEOPS_BENCH_LIVE not set; live network tests skipped",
)
@pytest.mark.asyncio
async def test_cerebras_live_smoke() -> None:
    client = make_client("cerebras")
    response = await client.complete(
        ClientCall(
            messages=[{"role": "user", "content": "Reply with exactly the word: ping"}],
            temperature=0.0,
            max_tokens=32,
        )
    )
    assert response.content is not None
    assert "ping" in response.content.lower() or response.content.strip() != ""
    assert response.usage.total_tokens > 0
