"""Tests for the OpenClaw adapter (Wave 2D).

The OpenClaw protocol is text-embedded — the model emits
``<tool_call>{"tool": "...", "args": {...}}</tool_call>`` blocks in its
prose response (mirroring the vendored runner at
``packages/benchmarks/openclaw-benchmark/openclaw/runner.py``). All
tests are mocked at the HTTP layer via :class:`httpx.MockTransport` —
no network, no live LLM calls.
"""

from __future__ import annotations

import json
import os
import re
from typing import Any

import httpx
import pytest

from eliza_lifeops_bench.agents import (
    OpenClawAgent,
    build_openclaw_agent,
)
from eliza_lifeops_bench.agents.openclaw import (
    _build_system_prompt,
    message_turns_to_openclaw,
    parse_openclaw_tool_calls,
)
from eliza_lifeops_bench.clients.cerebras import CerebrasClient
from eliza_lifeops_bench.types import MessageTurn


# ---------------------------------------------------------------------------
# Wire-format helpers
# ---------------------------------------------------------------------------


def _cerebras_response(
    *,
    text: str,
    prompt_tokens: int = 100,
    completion_tokens: int = 25,
) -> dict[str, Any]:
    """Build a Cerebras chat-completions response payload.

    OpenClaw responses are pure text (no native ``tool_calls``), so we
    only ever pass ``text`` here.
    """
    return {
        "id": "chatcmpl-openclaw-test",
        "model": "gpt-oss-120b",
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
            "prompt_tokens_details": {"cached_tokens": 0},
        },
    }


def _build_agent_with_transport(
    transport: httpx.MockTransport,
) -> tuple[OpenClawAgent, httpx.AsyncClient]:
    """Build an OpenClawAgent backed by a mocked CerebrasClient."""
    http_client = httpx.AsyncClient(transport=transport)

    def factory() -> CerebrasClient:
        return CerebrasClient(
            api_key="sk-test",
            model="gpt-oss-120b",
            http_client=http_client,
        )

    return OpenClawAgent(factory), http_client


_TOOL_MAIL_SEND: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "MAIL.send",
        "description": "Send an email to the given recipients.",
        "parameters": {
            "type": "object",
            "required": ["to_emails", "subject", "body_plain"],
            "properties": {
                "to_emails": {"type": "array", "items": {"type": "string"}},
                "subject": {"type": "string"},
                "body_plain": {"type": "string"},
            },
        },
    },
}


_TOOL_REMINDER_CREATE: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "REMINDER.create",
        "description": "Create a reminder.",
        "parameters": {
            "type": "object",
            "required": ["list_id", "title"],
            "properties": {
                "list_id": {"type": "string"},
                "title": {"type": "string"},
            },
        },
    },
}


# ---------------------------------------------------------------------------
# build_openclaw_agent: factory shape
# ---------------------------------------------------------------------------


def test_build_openclaw_agent_returns_openclaw_agent() -> None:
    """``build_openclaw_agent`` returns an ``OpenClawAgent``; client is lazy."""
    saved = os.environ.get("CEREBRAS_API_KEY")
    os.environ["CEREBRAS_API_KEY"] = "sk-test"
    try:
        agent = build_openclaw_agent()
        assert isinstance(agent, OpenClawAgent)
        assert agent.total_cost_usd == 0.0
        assert agent.total_input_tokens == 0
        assert agent.total_output_tokens == 0
        assert agent._client is None  # lazy
    finally:
        if saved is None:
            os.environ.pop("CEREBRAS_API_KEY", None)
        else:
            os.environ["CEREBRAS_API_KEY"] = saved


# ---------------------------------------------------------------------------
# Pure helpers: prompt building, history translation, parsing
# ---------------------------------------------------------------------------


def test_build_system_prompt_lists_tools_with_openclaw_format() -> None:
    """The system prompt must show each tool in OpenClaw text format."""
    prompt = _build_system_prompt([_TOOL_MAIL_SEND, _TOOL_REMINDER_CREATE])
    assert "MAIL.send" in prompt
    assert "REMINDER.create" in prompt
    # The OpenClaw text-embedded shape is documented in the prompt itself.
    assert '<tool_call>{"tool":' in prompt or '<tool_call>{"tool": "' in prompt
    # And the model is told NOT to use OpenAI native tool_calls.
    assert "tool_calls" in prompt and "native" in prompt.lower()


def test_build_system_prompt_handles_empty_tools_list() -> None:
    """No tools: the prompt still renders, with an explicit no-tools note."""
    prompt = _build_system_prompt([])
    assert "no tools available" in prompt.lower()


def test_message_turns_to_openclaw_folds_tool_results_into_user_msg() -> None:
    """Consecutive tool turns fold into one ``Tool results:`` user message."""
    history = [
        MessageTurn(role="user", content="book lunch and remind me"),
        MessageTurn(
            role="assistant",
            content="On it.",
            tool_calls=[
                {
                    "id": "x",
                    "type": "function",
                    "function": {
                        "name": "CALENDAR.create",
                        "arguments": json.dumps({"title": "Lunch"}),
                    },
                }
            ],
        ),
        MessageTurn(
            role="tool",
            content=json.dumps({"id": "e1"}),
            name="CALENDAR.create",
            tool_call_id="x",
        ),
        MessageTurn(
            role="tool",
            content=json.dumps({"id": "r1"}),
            name="REMINDER.create",
            tool_call_id="y",
        ),
    ]
    out = message_turns_to_openclaw(history)
    assert [m["role"] for m in out] == ["user", "assistant", "user"]
    # Assistant turn renders its prior tool_calls back as <tool_call> text.
    assert "<tool_call>" in out[1]["content"]
    assert "CALENDAR.create" in out[1]["content"]
    # Both tool results are folded into one user message in order.
    assert out[2]["content"].startswith("Tool results:")
    assert "[CALENDAR.create]" in out[2]["content"]
    assert "[REMINDER.create]" in out[2]["content"]


def test_parse_openclaw_tool_calls_extracts_blocks_and_strips_prose() -> None:
    """The parser pulls each ``<tool_call>{...}</tool_call>`` block out."""
    text = (
        "I'll do two things.\n"
        '<tool_call>{"tool": "MAIL.send", "args": {"subject": "hi"}}</tool_call>\n'
        "Then:\n"
        '<tool_call>{"tool": "REMINDER.create", "args": {"title": "x"}}</tool_call>'
    )
    prose, tool_calls = parse_openclaw_tool_calls(text)
    assert tool_calls is not None
    assert len(tool_calls) == 2
    assert tool_calls[0]["function"]["name"] == "MAIL.send"
    assert tool_calls[1]["function"]["name"] == "REMINDER.create"
    # Arguments are JSON-encoded strings (OpenAI-nested shape).
    args0 = json.loads(tool_calls[0]["function"]["arguments"])
    assert args0 == {"subject": "hi"}
    # Prose has the tool_call blocks stripped out.
    assert "<tool_call>" not in prose
    assert "I'll do two things." in prose


def test_parse_openclaw_tool_calls_raises_on_malformed_json() -> None:
    """Malformed JSON inside ``<tool_call>`` is a real failure."""
    text = '<tool_call>{not valid}</tool_call>'
    with pytest.raises(ValueError, match=r"not valid JSON"):
        parse_openclaw_tool_calls(text)


def test_parse_openclaw_tool_calls_raises_when_tool_key_missing() -> None:
    """Block must have a string ``tool`` key."""
    text = '<tool_call>{"args": {}}</tool_call>'
    with pytest.raises(ValueError, match=r"missing string 'tool' key"):
        parse_openclaw_tool_calls(text)


def test_parse_openclaw_tool_calls_raises_when_args_not_object() -> None:
    """Block ``args`` must be a JSON object."""
    text = '<tool_call>{"tool": "X", "args": "oops"}</tool_call>'
    with pytest.raises(ValueError, match=r"must be a JSON object"):
        parse_openclaw_tool_calls(text)


# ---------------------------------------------------------------------------
# Pass 2 fallback: unclosed <tool_call> recovery
#
# Regression: gpt-oss-120b under the OpenClaw protocol occasionally emits
# an opening ``<tool_call>`` and JSON body but never the closing tag (and
# sometimes appends a sentence of prose after the JSON). Before the
# brace-balanced fallback this dropped the tool_call silently and the
# scenario scored zero — see W1-3 lifeops openclaw baseline.
# ---------------------------------------------------------------------------


def test_parse_openclaw_unclosed_tool_call_at_end_of_text() -> None:
    text = (
        "We need to call MESSAGE.<tool_call>"
        '{"tool": "MESSAGE", "args": {"operation": "search_inbox",'
        ' "query": "from:approvals@example.test"}}'
    )
    prose, tool_calls = parse_openclaw_tool_calls(text)
    assert prose == "We need to call MESSAGE."
    assert len(tool_calls) == 1
    assert tool_calls[0]["function"]["name"] == "MESSAGE"
    args = json.loads(tool_calls[0]["function"]["arguments"])
    assert args == {
        "operation": "search_inbox",
        "query": "from:approvals@example.test",
    }


def test_parse_openclaw_unclosed_tool_call_with_trailing_prose() -> None:
    """The exact production failure observed in lifeops-openclaw-baseline."""
    text = (
        'We will search inbox.<tool_call>{"tool": "MESSAGE", "args":'
        ' {"operation": "search_inbox", "source": "gmail",'
        ' "query": "subject:\\"Quarterly Review\\""}}'
        "The task is complete."
    )
    prose, tool_calls = parse_openclaw_tool_calls(text)
    assert len(tool_calls) == 1
    assert tool_calls[0]["function"]["name"] == "MESSAGE"
    args = json.loads(tool_calls[0]["function"]["arguments"])
    assert args["query"] == 'subject:"Quarterly Review"'
    # Trailing prose after the JSON object is preserved in the prose
    # remainder so the runner can still surface model commentary.
    assert "The task is complete." in prose
    assert "<tool_call>" not in prose


def test_parse_openclaw_unclosed_nested_objects_balanced() -> None:
    text = (
        '<tool_call>{"tool": "PLAN", "args": {"steps":'
        ' [{"id": 1, "meta": {"k": "v"}}, {"id": 2}]}}'
        " trailing prose"
    )
    prose, tool_calls = parse_openclaw_tool_calls(text)
    assert len(tool_calls) == 1
    args = json.loads(tool_calls[0]["function"]["arguments"])
    assert args["steps"][0]["meta"] == {"k": "v"}
    assert "trailing prose" in prose


def test_parse_openclaw_unclosed_string_with_escaped_quotes() -> None:
    text = (
        '<tool_call>{"tool": "ECHO", "args": {"msg":'
        ' "she said \\"hi\\" and {left}"}}'
    )
    _, tool_calls = parse_openclaw_tool_calls(text)
    assert len(tool_calls) == 1
    args = json.loads(tool_calls[0]["function"]["arguments"])
    assert args["msg"] == 'she said "hi" and {left}'


def test_parse_openclaw_unclosed_opener_with_no_body_returns_empty() -> None:
    text = "thinking<tool_call> "
    prose, tool_calls = parse_openclaw_tool_calls(text)
    assert tool_calls == []
    assert "thinking" in prose


def test_parse_openclaw_unclosed_truncated_json_returns_empty() -> None:
    """An opener whose JSON body never closes braces returns no calls."""
    text = '<tool_call>{"tool": "X", "args": {"k": "v"'
    _, tool_calls = parse_openclaw_tool_calls(text)
    assert tool_calls == []


def test_parse_openclaw_no_tool_call_text_only() -> None:
    text = "Just a plain message with no tool call markers."
    prose, tool_calls = parse_openclaw_tool_calls(text)
    assert tool_calls == []
    assert prose == text


def test_parse_openclaw_closed_block_preferred_over_fallback() -> None:
    """If Pass 1 finds a closed block, Pass 2 must not also fire on the same
    text. (Avoids double-counting and reproduces the original strict
    behavior for compliant streams.)"""
    text = (
        'p.<tool_call>{"tool": "GOOD", "args": {"a": 1}}</tool_call>'
        ' tail <tool_call>{"tool": "ALSO_UNCLOSED", "args": {}}'
    )
    _, tool_calls = parse_openclaw_tool_calls(text)
    assert len(tool_calls) == 1
    assert tool_calls[0]["function"]["name"] == "GOOD"


# ---------------------------------------------------------------------------
# End-to-end: single turn with tool_call emission
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_openclaw_agent_returns_tool_call_turn_from_text() -> None:
    """Text-embedded ``<tool_call>`` blocks become ``MessageTurn.tool_calls``."""
    captured: list[dict[str, Any]] = []
    response_text = (
        "I'll send the email.\n"
        '<tool_call>{"tool": "MAIL.send", "args": '
        '{"to_emails": ["a@x.com"], "subject": "hi", "body_plain": "ping"}}'
        "</tool_call>"
    )

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(json.loads(request.content.decode("utf-8")))
        return httpx.Response(200, json=_cerebras_response(text=response_text))

    transport = httpx.MockTransport(handler)
    agent, http_client = _build_agent_with_transport(transport)
    try:
        history = [MessageTurn(role="user", content="email Alice 'ping'")]
        turn = await agent(history, [_TOOL_MAIL_SEND])
    finally:
        await http_client.aclose()

    assert turn.role == "assistant"
    # Prose has the tool_call block stripped; the framing sentence remains.
    assert "I'll send the email." in turn.content
    assert "<tool_call>" not in turn.content
    # tool_calls converted to OpenAI-nested shape.
    assert turn.tool_calls is not None and len(turn.tool_calls) == 1
    call = turn.tool_calls[0]
    assert call["type"] == "function"
    assert call["function"]["name"] == "MAIL.send"
    args = json.loads(call["function"]["arguments"])
    assert args["subject"] == "hi"

    # Wire format: OpenClaw protocol is text-embedded, so we MUST NOT send
    # native `tools` on the wire.
    body = captured[0]
    assert "tools" not in body
    # System prompt is leading and contains the tool catalogue.
    assert body["messages"][0]["role"] == "system"
    assert "MAIL.send" in body["messages"][0]["content"]


# ---------------------------------------------------------------------------
# Cost / latency / token telemetry propagation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_openclaw_agent_propagates_cost_and_token_telemetry() -> None:
    """``cost_usd`` / ``input_tokens`` / ``output_tokens`` land on the turn."""

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json=_cerebras_response(
                text="No further action needed.",
                prompt_tokens=200,
                completion_tokens=50,
            ),
        )

    transport = httpx.MockTransport(handler)
    agent, http_client = _build_agent_with_transport(transport)
    try:
        turn = await agent([MessageTurn(role="user", content="status?")], [])
    finally:
        await http_client.aclose()

    assert turn.tool_calls is None
    assert turn.content == "No further action needed."

    # Per-turn telemetry attributes the runner reads via getattr.
    assert getattr(turn, "input_tokens") == 200  # noqa: B009
    assert getattr(turn, "output_tokens") == 50  # noqa: B009
    cost_per_turn = getattr(turn, "cost_usd")  # noqa: B009
    assert cost_per_turn > 0.0
    assert getattr(turn, "latency_ms") >= 0  # noqa: B009

    # Aggregated on the agent instance.
    assert agent.total_cost_usd == cost_per_turn
    assert agent.total_input_tokens == 200
    assert agent.total_output_tokens == 50


# ---------------------------------------------------------------------------
# Multi-turn: tool_call → tool result threaded back → next tool_call → done
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_openclaw_agent_multi_turn_threads_tool_results() -> None:
    """Three turns; verify tool-results fold into a user message correctly."""
    responses = [
        _cerebras_response(
            text=(
                "Booking lunch.\n"
                '<tool_call>{"tool": "CALENDAR.create", "args": '
                '{"title": "Lunch", "start": "2026-05-10T12:00:00Z", '
                '"end": "2026-05-10T13:00:00Z"}}</tool_call>'
            )
        ),
        _cerebras_response(
            text=(
                "Adding reminder.\n"
                '<tool_call>{"tool": "REMINDER.create", "args": '
                '{"list_id": "default", "title": "leave for lunch"}}'
                "</tool_call>"
            )
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
        history: list[MessageTurn] = [
            MessageTurn(role="user", content="book lunch + remind me"),
        ]

        # --- Turn 1 ---
        turn1 = await agent(history, [_TOOL_REMINDER_CREATE])
        assert turn1.tool_calls is not None
        assert turn1.tool_calls[0]["function"]["name"] == "CALENDAR.create"
        history.append(turn1)
        history.append(
            MessageTurn(
                role="tool",
                content=json.dumps({"id": "e1", "title": "Lunch"}),
                name="CALENDAR.create",
                tool_call_id=turn1.tool_calls[0]["id"],
            )
        )

        # --- Turn 2 ---
        turn2 = await agent(history, [_TOOL_REMINDER_CREATE])
        assert turn2.tool_calls is not None
        assert turn2.tool_calls[0]["function"]["name"] == "REMINDER.create"
        history.append(turn2)
        history.append(
            MessageTurn(
                role="tool",
                content=json.dumps({"id": "r1"}),
                name="REMINDER.create",
                tool_call_id=turn2.tool_calls[0]["id"],
            )
        )

        # --- Turn 3 ---
        turn3 = await agent(history, [_TOOL_REMINDER_CREATE])
        assert turn3.tool_calls is None
        assert "Lunch booked" in turn3.content
    finally:
        await http_client.aclose()

    # Cumulative cost matches sum of per-turn costs.
    assert agent.total_cost_usd == pytest.approx(
        sum(getattr(t, "cost_usd") for t in [turn1, turn2, turn3])  # noqa: B009
    )

    # Wire format on the third request:
    # - leads with our system prompt
    # - then the original user message
    # - then assistant turn 1 rendered with embedded <tool_call>
    # - then a folded "Tool results:" user message containing the
    #   CALENDAR.create result
    # - then assistant turn 2 rendered with embedded <tool_call>
    # - then a folded "Tool results:" user message containing the
    #   REMINDER.create result
    last_body = captured[2]
    msg_roles = [m["role"] for m in last_body["messages"]]
    assert msg_roles == ["system", "user", "assistant", "user", "assistant", "user"]
    assert last_body["messages"][3]["content"].startswith("Tool results:")
    assert "[CALENDAR.create]" in last_body["messages"][3]["content"]
    assert last_body["messages"][5]["content"].startswith("Tool results:")
    assert "[REMINDER.create]" in last_body["messages"][5]["content"]
    # And we still never send native `tools` on the wire.
    assert "tools" not in last_body
    # Assistant turns embed <tool_call> text — that's the OpenClaw protocol.
    assert re.search(r"<tool_call>.*CALENDAR\.create.*</tool_call>", last_body["messages"][2]["content"])
    assert re.search(r"<tool_call>.*REMINDER\.create.*</tool_call>", last_body["messages"][4]["content"])


# ---------------------------------------------------------------------------
# Error propagation: provider 4xx must surface
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_openclaw_agent_propagates_provider_error() -> None:
    """A 4xx must surface as ProviderError — not be swallowed."""
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
async def test_openclaw_agent_live_smoke() -> None:
    """Hits the configured Cerebras endpoint through the OpenClaw protocol."""
    agent = build_openclaw_agent()
    turn = await agent(
        [MessageTurn(role="user", content="Reply with exactly the word: ping")],
        [],
    )
    assert turn.role == "assistant"
    assert turn.content
    assert agent.total_cost_usd >= 0.0
