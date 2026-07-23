"""Guards that the eliza ClawBench adapter routes Eliza's built-in REPLY/NONE/
IGNORE responses to the answer channel instead of surfacing them as ClawBench
tool calls, while a genuinely undeclared NON-reply tool still fails fast.

The eliza runtime answers a ClawBench scenario by emitting its conversational
``REPLY`` action (the natural-language answer lives in ``resp.text``); the
hermes/openclaw native tool bridges never surface REPLY because they only
expose the declared benchmark tools. Before this fix the adapter's
captured-actions fallback turned REPLY into a tool call, which
``_normalize_tool_calls`` rejected as an "undeclared tool" — crashing the
whole eliza leg. These tests drive the real adapter callable with a fake
``ElizaClient`` returning ``MessageResponse`` shapes the TS bench server
actually produces (no live server / model).
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from clawbench import multi_harness_runner

# The adapter lives in the sibling ``eliza-adapter`` package; the runner adds
# it to sys.path at build time via this same helper.
multi_harness_runner._prepend_adapter_package("eliza-adapter")

from eliza_adapter.clawbench import build_clawbench_agent_fn  # noqa: E402
from eliza_adapter.client import MessageResponse  # noqa: E402


class _FakeElizaClient:
    """Minimal ElizaClient stand-in: returns one canned MessageResponse."""

    _delegate = None

    def __init__(self, response: MessageResponse) -> None:
        self._response = response
        self.sent: list[tuple[str, dict[str, Any] | None]] = []

    def wait_until_ready(self, timeout: float = 120.0) -> None:
        return None

    def reset(self, *, task_id: str, benchmark: str) -> dict[str, Any]:
        return {"task_id": task_id, "benchmark": benchmark}

    def send_message(
        self, text: str, context: dict[str, Any] | None = None
    ) -> MessageResponse:
        self.sent.append((text, context))
        return self._response


def _run_agent(response: MessageResponse, *, tools: list[str]) -> dict[str, Any]:
    client = _FakeElizaClient(response)
    agent_fn = build_clawbench_agent_fn(
        client=client,
        scenario_yaml={"name": "reply_scenario", "prompt": "Triage the inbox."},
        fixtures={},
        model_name="gemma-4-31b",
    )
    tool_schemas = multi_harness_runner.tool_schemas(tools)
    return asyncio.run(agent_fn([{"role": "user", "content": "go"}], tool_schemas))


def test_reply_action_becomes_answer_not_tool_call() -> None:
    """A turn whose only action is Eliza's REPLY carries the answer as text."""
    response = MessageResponse(
        text="### Email Triage Summary\nUrgent: boss@company.com",
        thought=None,
        actions=["REPLY"],
        params={"tool_calls": []},
    )
    result = _run_agent(response, tools=["read"])
    assert result["tool_calls"] == []
    assert result["text"] == "### Email Triage Summary\nUrgent: boss@company.com"


def test_reply_inside_tool_calls_is_filtered() -> None:
    """REPLY surfaced in the structured ``tool_calls`` list is also dropped."""
    response = MessageResponse(
        text="Done.",
        thought=None,
        actions=[],
        params={
            "tool_calls": [
                {"id": "c1", "name": "REPLY", "arguments": {"text": "Done."}}
            ]
        },
    )
    result = _run_agent(response, tools=["read"])
    assert result["tool_calls"] == []
    assert result["text"] == "Done."


def test_declared_tool_survives_alongside_reply_in_actions() -> None:
    """The captured-actions fallback keeps a real declared tool, drops REPLY."""
    response = MessageResponse(
        text="Read the message, then replied.",
        thought=None,
        actions=["read", "REPLY"],
        params={"read": {"path": "inbox.md"}},
    )
    result = _run_agent(response, tools=["read"])
    names = [call["name"] for call in result["tool_calls"]]
    assert names == ["read"]
    assert result["tool_calls"][0]["arguments"] == {"path": "inbox.md"}


def test_undeclared_non_reply_tool_is_not_filtered_and_still_rejected() -> None:
    """A non-reply tool the scenario never declared must not be silently
    swallowed: the adapter passes it through, and ``_normalize_tool_calls``
    fails fast — the exact guarantee the REPLY filter must not weaken."""
    response = MessageResponse(
        text="",
        thought=None,
        actions=[],
        params={
            "tool_calls": [
                {"id": "c1", "name": "send_sms", "arguments": {"to": "+1"}}
            ]
        },
    )
    result = _run_agent(response, tools=["read"])
    assert [call["name"] for call in result["tool_calls"]] == ["send_sms"]

    with pytest.raises(ValueError, match="undeclared tool 'send_sms'"):
        multi_harness_runner._normalize_tool_calls(
            result["tool_calls"],
            allowed_tools={"read"},
            turn=1,
        )
