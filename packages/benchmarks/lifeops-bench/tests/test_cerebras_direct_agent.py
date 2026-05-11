"""Tests for the Cerebras-direct adapter (Wave 2E sibling).

Mocked end-to-end via :class:`httpx.MockTransport` — Cerebras's endpoint
speaks native OpenAI tool-calling, so the wire format and response shape
match the OpenAI chat-completions reference exactly.
"""

from __future__ import annotations

import json
import os
from typing import Any

import httpx
import pytest

from eliza_lifeops_bench.agents import (
    OpenAICompatAgent,
    build_cerebras_direct_agent,
)
from eliza_lifeops_bench.clients.cerebras import CerebrasClient
from eliza_lifeops_bench.types import MessageTurn


def _cerebras_response(
    *,
    text: str | None,
    tool_calls: list[dict[str, Any]] | None = None,
    prompt_tokens: int = 100,
    completion_tokens: int = 25,
) -> dict[str, Any]:
    message: dict[str, Any] = {"role": "assistant", "content": text}
    finish_reason = "stop"
    if tool_calls:
        message["tool_calls"] = tool_calls
        finish_reason = "tool_calls"
    return {
        "id": "chatcmpl-test",
        "model": "gpt-oss-120b",
        "choices": [
            {
                "index": 0,
                "finish_reason": finish_reason,
                "message": message,
            }
        ],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
            "prompt_tokens_details": {"cached_tokens": 0},
        },
    }


def _build_agent_with_transport(
    transport: httpx.MockTransport,
) -> tuple[OpenAICompatAgent, httpx.AsyncClient]:
    """Build an OpenAICompatAgent backed by a mocked CerebrasClient."""
    http_client = httpx.AsyncClient(transport=transport)

    def factory() -> CerebrasClient:
        return CerebrasClient(
            api_key="sk-test",
            model="gpt-oss-120b",
            http_client=http_client,
        )

    return OpenAICompatAgent(factory), http_client


# ---------------------------------------------------------------------------
# build_cerebras_direct_agent: factory shape
# ---------------------------------------------------------------------------


def test_build_cerebras_direct_agent_returns_open_ai_compat_agent() -> None:
    """``build_cerebras_direct_agent`` returns an ``OpenAICompatAgent``."""
    saved = os.environ.get("CEREBRAS_API_KEY")
    os.environ["CEREBRAS_API_KEY"] = "sk-test"
    try:
        agent = build_cerebras_direct_agent()
        assert isinstance(agent, OpenAICompatAgent)
        assert agent.total_cost_usd == 0.0
        assert agent._client is None  # lazy
    finally:
        if saved is None:
            os.environ.pop("CEREBRAS_API_KEY", None)
        else:
            os.environ["CEREBRAS_API_KEY"] = saved


# ---------------------------------------------------------------------------
# Single-turn with native tool_call
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_cerebras_direct_agent_returns_tool_call_turn() -> None:
    """Native ``tool_calls`` in the response surface as ``tool_calls`` on the turn."""
    captured: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(json.loads(request.content.decode("utf-8")))
        return httpx.Response(
            200,
            json=_cerebras_response(
                text="Looking it up.",
                tool_calls=[
                    {
                        "id": "call_xyz",
                        "type": "function",
                        "function": {
                            "name": "MAIL.send",
                            "arguments": json.dumps(
                                {
                                    "message_id": "m1",
                                    "thread_id": "t1",
                                    "from_email": "me@x.com",
                                    "to_emails": ["a@x.com"],
                                    "subject": "hi",
                                    "body_plain": "ping",
                                }
                            ),
                        },
                    }
                ],
            ),
        )

    transport = httpx.MockTransport(handler)
    agent, http_client = _build_agent_with_transport(transport)
    try:
        history = [MessageTurn(role="user", content="email Alice 'ping'")]
        tools = [
            {
                "type": "function",
                "function": {
                    "name": "MAIL.send",
                    "description": "send an email",
                    "parameters": {"type": "object", "properties": {}},
                },
            }
        ]
        turn = await agent(history, tools)
    finally:
        await http_client.aclose()

    assert turn.role == "assistant"
    assert turn.content == "Looking it up."
    assert turn.tool_calls is not None
    assert len(turn.tool_calls) == 1
    call = turn.tool_calls[0]
    assert call["function"]["name"] == "MAIL.send"
    args = json.loads(call["function"]["arguments"])
    assert args["subject"] == "hi"

    # Telemetry attached to the turn for the runner's getattr accounting
    assert getattr(turn, "cost_usd") > 0.0  # noqa: B009
    assert agent.total_cost_usd == getattr(turn, "cost_usd")  # noqa: B009
    assert getattr(turn, "input_tokens") == 100  # noqa: B009
    assert getattr(turn, "output_tokens") == 25  # noqa: B009

    # Wire format: tools threaded through unchanged; messages in OpenAI shape.
    body = captured[0]
    assert body["model"] == "gpt-oss-120b"
    assert "tools" in body and len(body["tools"]) == 1
    assert body["messages"][0]["role"] == "system"
    assert body["messages"][1]["role"] == "user"


# ---------------------------------------------------------------------------
# Pure prose / no tool_calls
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_cerebras_direct_agent_pure_prose_no_tool_calls() -> None:
    """A response with no native ``tool_calls`` yields ``tool_calls = None``."""

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json=_cerebras_response(text="No further action needed.")
        )

    transport = httpx.MockTransport(handler)
    agent, http_client = _build_agent_with_transport(transport)
    try:
        turn = await agent([MessageTurn(role="user", content="status?")], [])
    finally:
        await http_client.aclose()

    assert turn.content == "No further action needed."
    assert turn.tool_calls is None


# ---------------------------------------------------------------------------
# Empty tools list
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_cerebras_direct_agent_handles_empty_tools_list() -> None:
    """Empty tools list must not crash and must NOT be sent on the wire."""

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content.decode("utf-8"))
        # When call.tools is None, CerebrasClient omits the `tools` field.
        assert "tools" not in body
        return httpx.Response(200, json=_cerebras_response(text="OK"))

    transport = httpx.MockTransport(handler)
    agent, http_client = _build_agent_with_transport(transport)
    try:
        turn = await agent([MessageTurn(role="user", content="hi")], [])
    finally:
        await http_client.aclose()

    assert turn.content == "OK"


# ---------------------------------------------------------------------------
# Multi-turn: agent → tool-result → agent → done
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_cerebras_direct_agent_multi_turn_threads_tool_results() -> None:
    """Three turns; verify tool_call_id/role plumbing is preserved on the wire."""
    responses = [
        _cerebras_response(
            text=None,
            tool_calls=[
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {
                        "name": "CALENDAR.create",
                        "arguments": json.dumps(
                            {
                                "event_id": "e1",
                                "calendar_id": "primary",
                                "title": "Lunch",
                                "start": "2026-05-10T12:00:00Z",
                                "end": "2026-05-10T13:00:00Z",
                            }
                        ),
                    },
                }
            ],
        ),
        _cerebras_response(
            text=None,
            tool_calls=[
                {
                    "id": "call_2",
                    "type": "function",
                    "function": {
                        "name": "REMINDER.create",
                        "arguments": json.dumps(
                            {
                                "reminder_id": "r1",
                                "list_id": "default",
                                "title": "leave for lunch",
                            }
                        ),
                    },
                }
            ],
        ),
        _cerebras_response(text="Lunch booked, reminder set."),
    ]
    captured: list[dict[str, Any]] = []
    call_index = {"i": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(json.loads(request.content.decode("utf-8")))
        i = call_index["i"]
        call_index["i"] += 1
        return httpx.Response(200, json=responses[i])

    transport = httpx.MockTransport(handler)
    agent, http_client = _build_agent_with_transport(transport)
    try:
        history: list[MessageTurn] = [MessageTurn(role="user", content="book lunch + remind me")]

        # --- Turn 1 ---
        turn1 = await agent(history, [])
        assert turn1.tool_calls is not None and turn1.tool_calls[0]["function"]["name"] == "CALENDAR.create"
        history.append(turn1)
        history.append(
            MessageTurn(
                role="tool",
                content=json.dumps({"id": "e1", "title": "Lunch"}),
                name="CALENDAR.create",
                tool_call_id="call_1",
            )
        )

        # --- Turn 2 ---
        turn2 = await agent(history, [])
        assert turn2.tool_calls is not None and turn2.tool_calls[0]["function"]["name"] == "REMINDER.create"
        history.append(turn2)
        history.append(
            MessageTurn(
                role="tool",
                content=json.dumps({"id": "r1"}),
                name="REMINDER.create",
                tool_call_id="call_2",
            )
        )

        # --- Turn 3: terminal ---
        turn3 = await agent(history, [])
        assert turn3.tool_calls is None
        assert "Lunch booked" in turn3.content
    finally:
        await http_client.aclose()

    assert agent.total_cost_usd == pytest.approx(
        sum(getattr(t, "cost_usd") for t in [turn1, turn2, turn3])  # noqa: B009
    )

    # The third request preserves tool-role messages with tool_call_id intact.
    last_body = captured[2]
    msg_roles = [m["role"] for m in last_body["messages"]]
    assert msg_roles == ["user", "assistant", "tool", "assistant", "tool"]
    assert last_body["messages"][2]["tool_call_id"] == "call_1"
    assert last_body["messages"][4]["tool_call_id"] == "call_2"


# ---------------------------------------------------------------------------
# Error propagation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_cerebras_direct_agent_propagates_provider_error() -> None:
    """A 4xx must surface as ``ProviderError`` — not be swallowed."""
    from eliza_lifeops_bench.clients.base import ProviderError

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, text="bad request")

    transport = httpx.MockTransport(handler)
    agent, http_client = _build_agent_with_transport(transport)
    try:
        with pytest.raises(ProviderError):
            await agent([MessageTurn(role="user", content="hi")], [])
    finally:
        await http_client.aclose()


# ---------------------------------------------------------------------------
# Live test (skipped unless LIFEOPS_BENCH_LIVE=1)
# ---------------------------------------------------------------------------


@pytest.mark.skipif(
    os.environ.get("LIFEOPS_BENCH_LIVE") != "1",
    reason="LIFEOPS_BENCH_LIVE not set; live network tests skipped",
)
@pytest.mark.asyncio
async def test_cerebras_direct_agent_live_smoke() -> None:
    """Hits the configured Cerebras endpoint for a real round-trip."""
    agent = build_cerebras_direct_agent()
    turn = await agent(
        [MessageTurn(role="user", content="Reply with exactly the word: ping")],
        [],
    )
    assert turn.role == "assistant"
    assert turn.content
    assert agent.total_cost_usd >= 0.0
