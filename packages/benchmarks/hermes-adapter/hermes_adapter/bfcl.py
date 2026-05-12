"""BFCL-style agent_fn factory backed by hermes-agent.

BFCL (Berkeley Function-Call Leaderboard) drives the agent with a single
turn: a user prompt plus an OpenAI-format ``tools=`` array. The agent returns
either text or a structured list of function calls. There is no multi-turn
loop and no real tool execution — the runner scores the emitted calls.

This adapter exposes a builder ``build_bfcl_agent_fn`` that returns an async
callable matching the duck-typed shape BFCL runners expect.
"""

from __future__ import annotations

import logging
from typing import Any, Awaitable, Callable

from hermes_adapter.client import HermesClient

logger = logging.getLogger(__name__)


def build_bfcl_agent_fn(
    *,
    client: HermesClient | None = None,
    fixtures: dict[str, Any] | None = None,
    system_prompt: str | None = None,
) -> Callable[[str, list[dict[str, Any]]], Awaitable[dict[str, Any]]]:
    """Build an async BFCL-compatible callable.

    Returned signature::

        async def agent_fn(prompt: str, tools: list[dict]) -> dict

    The returned dict shape is::

        {
            "text": <assistant content>,
            "tool_calls": [{"name": str, "arguments": <str|dict>}, ...],
            "thought": <reasoning_content or None>,
        }
    """
    del fixtures  # accepted for parity, currently unused
    bridge = client or HermesClient()
    bridge.wait_until_ready(timeout=60)

    async def _agent_fn(prompt: str, tools: list[dict[str, Any]]) -> dict[str, Any]:
        context: dict[str, object] = {"tools": tools or []}
        if system_prompt:
            context["system_prompt"] = system_prompt
        try:
            resp = bridge.send_message(prompt, context=context)
        except Exception as exc:
            logger.exception("[hermes-bfcl] send_message failed")
            raise RuntimeError("hermes BFCL send_message failed") from exc

        raw_tool_calls = resp.params.get("tool_calls") if isinstance(resp.params, dict) else None
        tool_calls: list[dict[str, Any]] = []
        if isinstance(raw_tool_calls, list):
            for entry in raw_tool_calls:
                if not isinstance(entry, dict):
                    continue
                name = str(entry.get("name") or "")
                if not name:
                    continue
                tool_calls.append(
                    {
                        "name": name,
                        "arguments": entry.get("arguments", ""),
                    }
                )

        return {
            "text": resp.text,
            "tool_calls": tool_calls,
            "thought": resp.thought,
        }

    return _agent_fn
