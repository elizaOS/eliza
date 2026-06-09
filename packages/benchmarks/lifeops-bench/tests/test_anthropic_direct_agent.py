"""Tests for the Anthropic-direct LifeOpsBench adapter."""

from __future__ import annotations

from typing import Any

import pytest

import eliza_lifeops_bench.agents.anthropic_direct as anthropic_direct_mod
from eliza_lifeops_bench.agents import (
    OpenAICompatAgent,
    build_anthropic_direct_agent,
)
from eliza_lifeops_bench.clients.base import ClientCall, ClientResponse, ToolCall, Usage
from eliza_lifeops_bench.types import MessageTurn


def test_build_anthropic_direct_agent_returns_open_ai_compat_agent() -> None:
    agent = build_anthropic_direct_agent(model="claude-opus-4-7")

    assert isinstance(agent, OpenAICompatAgent)
    assert agent.total_cost_usd == 0.0
    assert agent._client is None


@pytest.mark.asyncio
async def test_anthropic_direct_agent_threads_call_options(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: list[ClientCall] = []

    class FakeAnthropicClient:
        def __init__(self, **kwargs: Any) -> None:
            self.kwargs = kwargs

        async def complete(self, call: ClientCall) -> ClientResponse:
            captured.append(call)
            return ClientResponse(
                content=None,
                tool_calls=[
                    ToolCall(
                        id="toolu_1",
                        name="REMINDER.create",
                        arguments={"title": "ship PR"},
                    )
                ],
                finish_reason="tool_calls",
                usage=Usage(
                    prompt_tokens=100,
                    completion_tokens=25,
                    total_tokens=125,
                    cached_tokens=0,
                    cache_read_input_tokens=0,
                    cache_creation_input_tokens=8,
                ),
                latency_ms=12,
                cost_usd=0.123,
                raw_provider_response={},
            )

    monkeypatch.setattr(anthropic_direct_mod, "AnthropicClient", FakeAnthropicClient)

    agent = build_anthropic_direct_agent(
        model="claude-opus-4-7",
        api_key="sk-test",
        temperature=0.2,
        max_tokens=1234,
    )

    turn = await agent(
        [MessageTurn(role="user", content="Remind me to ship the PR")],
        [
            {
                "type": "function",
                "function": {
                    "name": "REMINDER.create",
                    "description": "Create a reminder",
                    "parameters": {"type": "object", "properties": {}},
                },
            }
        ],
    )

    assert turn.tool_calls is not None
    assert turn.tool_calls[0]["function"]["name"] == "REMINDER.create"
    assert getattr(turn, "cache_read_input_tokens") == 0
    assert getattr(turn, "cache_creation_input_tokens") == 8
    assert agent.total_cost_usd == pytest.approx(0.123)
    assert agent.total_input_tokens == 100
    assert agent.total_output_tokens == 25

    call = captured[0]
    assert call.temperature == 0.2
    assert call.max_tokens == 1234
    assert call.tools is not None
    assert call.messages[0]["role"] == "system"
    assert call.messages[1] == {
        "role": "user",
        "content": "Remind me to ship the PR",
    }
