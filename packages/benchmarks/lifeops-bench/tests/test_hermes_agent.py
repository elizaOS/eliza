"""Tests for the Hermes adapter (Wave 2E).

Mocked end-to-end via :class:`httpx.MockTransport` — no real network
unless ``LIFEOPS_BENCH_LIVE=1`` is set.
"""

from __future__ import annotations

import json
import os
from typing import Any

import httpx
import pytest

from eliza_lifeops_bench.agents import (
    OpenAICompatAgent,
    build_hermes_agent,
)
from eliza_lifeops_bench.clients.hermes import HermesClient
from eliza_lifeops_bench.types import MessageTurn


def _hermes_response(text: str, *, prompt_tokens: int = 80, completion_tokens: int = 40) -> dict[str, Any]:
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
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        },
    }


def _build_agent_with_transport(
    transport: httpx.MockTransport,
) -> tuple[OpenAICompatAgent, httpx.AsyncClient]:
    """Return an OpenAICompatAgent wired to a mocked HermesClient."""
    http_client = httpx.AsyncClient(transport=transport)

    def factory() -> HermesClient:
        return HermesClient(
            base_url="https://hermes.example.com/v1",
            api_key="sk-hermes-test",
            model="NousResearch/Hermes-3-Llama-3.1-70B",
            http_client=http_client,
        )

    agent = OpenAICompatAgent(factory)
    return agent, http_client


# ---------------------------------------------------------------------------
# build_hermes_agent: factory shape
# ---------------------------------------------------------------------------


def test_build_hermes_agent_returns_open_ai_compat_agent() -> None:
    """``build_hermes_agent`` returns an ``OpenAICompatAgent`` (callable + cost-tracking)."""
    saved = os.environ.get("HERMES_BASE_URL")
    os.environ["HERMES_BASE_URL"] = "https://hermes.example.com/v1"
    try:
        agent = build_hermes_agent()
        assert isinstance(agent, OpenAICompatAgent)
        assert agent.total_cost_usd == 0.0
        # Lazy: client not constructed until first call
        assert agent._client is None
    finally:
        if saved is None:
            os.environ.pop("HERMES_BASE_URL", None)
        else:
            os.environ["HERMES_BASE_URL"] = saved


# ---------------------------------------------------------------------------
# Single-turn end-to-end with one tool_call
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_hermes_agent_returns_tool_call_turn() -> None:
    """A response with a ``<tool_call>`` block surfaces as ``tool_calls`` on the turn."""
    captured: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(json.loads(request.content.decode("utf-8")))
        return httpx.Response(
            200,
            json=_hermes_response(
                'Checking now.\n<tool_call>{"name": "CALENDAR.create", '
                '"arguments": {"event_id": "e1", "calendar_id": "primary", '
                '"title": "Lunch", "start": "2026-05-10T12:00:00Z", '
                '"end": "2026-05-10T13:00:00Z"}}</tool_call>'
            ),
        )

    transport = httpx.MockTransport(handler)
    agent, http_client = _build_agent_with_transport(transport)
    try:
        history = [MessageTurn(role="user", content="schedule lunch tomorrow at noon")]
        tools = [
            {
                "type": "function",
                "function": {
                    "name": "CALENDAR.create",
                    "description": "create a calendar event",
                    "parameters": {"type": "object", "properties": {}},
                },
            }
        ]
        turn = await agent(history, tools)
    finally:
        await http_client.aclose()

    assert turn.role == "assistant"
    # Both prose AND tool_calls preserved — the runner needs the prose for
    # substring matching and the tool_calls for execution.
    assert turn.content == "Checking now."
    assert turn.tool_calls is not None
    assert len(turn.tool_calls) == 1
    call = turn.tool_calls[0]
    assert call["type"] == "function"
    assert call["function"]["name"] == "CALENDAR.create"
    args = json.loads(call["function"]["arguments"])
    assert args["event_id"] == "e1"
    assert args["title"] == "Lunch"

    # Cost propagation: per-turn attached + cumulative on agent
    assert getattr(turn, "cost_usd") > 0.0  # noqa: B009
    assert agent.total_cost_usd == getattr(turn, "cost_usd")  # noqa: B009
    assert getattr(turn, "input_tokens") == 80  # noqa: B009
    assert getattr(turn, "output_tokens") == 40  # noqa: B009

    # Wire format: history converted to OpenAI shape with the user message preserved.
    body = captured[0]
    user_msgs = [m for m in body["messages"] if m["role"] == "user"]
    assert any("schedule lunch" in m["content"] for m in user_msgs)


# ---------------------------------------------------------------------------
# Pure prose response — terminal RESPOND
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_hermes_agent_pure_prose_no_tool_calls() -> None:
    """A model response with no ``<tool_call>`` blocks yields an empty/None tool_calls."""

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json=_hermes_response("Done — your meeting is on the calendar."),
        )

    transport = httpx.MockTransport(handler)
    agent, http_client = _build_agent_with_transport(transport)
    try:
        turn = await agent([MessageTurn(role="user", content="anything else?")], [])
    finally:
        await http_client.aclose()

    assert turn.role == "assistant"
    assert turn.content == "Done — your meeting is on the calendar."
    # Runner treats `not agent_actions` as terminal; both None and []
    # satisfy that. We emit None for the no-calls case.
    assert turn.tool_calls is None


# ---------------------------------------------------------------------------
# Empty tools list
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_hermes_agent_handles_empty_tools_list() -> None:
    """Hermes still needs its system prompt; an empty tools list must not crash."""

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content.decode("utf-8"))
        # System prompt is still emitted (Hermes template) even with no tools.
        assert body["messages"][0]["role"] == "system"
        assert "<tools>" in body["messages"][0]["content"]
        return httpx.Response(200, json=_hermes_response("Sure."))

    transport = httpx.MockTransport(handler)
    agent, http_client = _build_agent_with_transport(transport)
    try:
        turn = await agent([MessageTurn(role="user", content="hi")], [])
    finally:
        await http_client.aclose()

    assert turn.content == "Sure."


# ---------------------------------------------------------------------------
# Multi-turn: agent → tool-result → agent → done
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_hermes_agent_multi_turn_threads_tool_results() -> None:
    """Three turns: tool_call → tool_result fed back → another tool_call → final prose."""
    responses = [
        _hermes_response(
            '<tool_call>{"name": "REMINDER.create", "arguments": '
            '{"reminder_id": "r1", "list_id": "default", "title": "Pay rent"}}'
            "</tool_call>"
        ),
        _hermes_response(
            '<tool_call>{"name": "REMINDER.complete", "arguments": '
            '{"reminder_id": "r1"}}</tool_call>'
        ),
        _hermes_response("All set — reminder created and marked done."),
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
        history: list[MessageTurn] = [MessageTurn(role="user", content="add a reminder to pay rent")]

        # --- Turn 1 ---
        turn1 = await agent(history, [])
        assert turn1.tool_calls is not None and len(turn1.tool_calls) == 1
        assert turn1.tool_calls[0]["function"]["name"] == "REMINDER.create"
        history.append(turn1)
        history.append(
            MessageTurn(
                role="tool",
                content=json.dumps({"id": "r1"}),
                name="REMINDER.create",
                tool_call_id=turn1.tool_calls[0]["id"],
            )
        )

        # --- Turn 2 ---
        turn2 = await agent(history, [])
        assert turn2.tool_calls is not None and len(turn2.tool_calls) == 1
        assert turn2.tool_calls[0]["function"]["name"] == "REMINDER.complete"
        history.append(turn2)
        history.append(
            MessageTurn(
                role="tool",
                content=json.dumps({"id": "r1", "completed_at": "2026-05-10T12:01:00Z"}),
                name="REMINDER.complete",
                tool_call_id=turn2.tool_calls[0]["id"],
            )
        )

        # --- Turn 3: terminal ---
        turn3 = await agent(history, [])
        assert turn3.tool_calls is None
        assert "All set" in turn3.content
    finally:
        await http_client.aclose()

    # Cost accumulated across all three turns
    assert agent.total_cost_usd == pytest.approx(
        sum(getattr(t, "cost_usd") for t in [turn1, turn2, turn3])  # noqa: B009
    )
    assert agent.total_input_tokens == 80 * 3
    assert agent.total_output_tokens == 40 * 3

    # The third request's message list contains the prior assistant turns
    # (with tool_calls re-rendered as Hermes <tool_call> blocks) AND the
    # tool-results fed back as <tool_response> blocks. We verify the
    # round-trip by inspecting the last captured request's message list.
    last_body = captured[2]
    msg_roles = [m["role"] for m in last_body["messages"]]
    # System + user + (assistant + user-as-tool-response) × 2
    assert msg_roles == ["system", "user", "assistant", "user", "assistant", "user"]
    # Tool responses rendered into user-role <tool_response> blocks
    assert "<tool_response>" in last_body["messages"][3]["content"]
    assert "<tool_response>" in last_body["messages"][5]["content"]
    # Prior assistant tool_calls re-rendered as <tool_call> blocks
    assert "<tool_call>" in last_body["messages"][2]["content"]
    assert "REMINDER.create" in last_body["messages"][2]["content"]


# ---------------------------------------------------------------------------
# Error propagation: ProviderError must NOT be swallowed
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_hermes_agent_propagates_provider_error() -> None:
    """A 4xx from the endpoint must surface as ``ProviderError`` — not be swallowed."""
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
async def test_hermes_agent_live_smoke() -> None:
    """Hits the configured ``HERMES_BASE_URL`` for a real round-trip."""
    agent = build_hermes_agent()
    turn = await agent(
        [MessageTurn(role="user", content="Reply with exactly the word: ping")],
        [],
    )
    assert turn.role == "assistant"
    assert turn.content
    assert agent.total_cost_usd >= 0.0
