"""Deterministic mock agent for smoke runs.

The mock agent looks at the most recent user transcript and emits the
expected tool calls verbatim when the fixture's transcript carries an
embedded ``[tool: <name> <json-args>]`` directive. Without a directive,
it produces a single text reply echoing the transcript.

This lets ``--mock --limit N`` exercise the full pipeline (STT
passthrough, agent loop, evaluator, scorer) with no network and a
predictable score.
"""

from __future__ import annotations

import json
import re
from typing import Any

from ..types import AgentFn, MessageTurn

_TOOL_DIRECTIVE = re.compile(r"\[tool:\s*(?P<name>[\w.\-]+)\s*(?P<args>\{.*?\})\s*\]")


def build_mock_agent() -> AgentFn:
    """Build a deterministic mock agent."""

    async def _agent(
        history: list[MessageTurn], _tools: list[dict[str, Any]]
    ) -> MessageTurn:
        last_user = next(
            (h for h in reversed(history) if h.role == "user"), None
        )
        text = (last_user.content if last_user else "") or ""

        if history and history[-1].role == "tool":
            return MessageTurn(role="assistant", content="done.")

        calls: list[dict[str, Any]] = []
        for i, m in enumerate(_TOOL_DIRECTIVE.finditer(text)):
            try:
                args = json.loads(m.group("args"))
            except json.JSONDecodeError:
                args = {}
            calls.append(
                {
                    "id": f"call_{i}",
                    "name": m.group("name"),
                    "arguments": args if isinstance(args, dict) else {},
                }
            )
        if calls:
            return MessageTurn(
                role="assistant",
                content="",
                tool_calls=calls,
            )

        if "[refuse]" in text:
            return MessageTurn(
                role="assistant",
                content="I'm sorry, I cannot help with that request.",
            )
        return MessageTurn(role="assistant", content=f"ack: {text}")

    return _agent
