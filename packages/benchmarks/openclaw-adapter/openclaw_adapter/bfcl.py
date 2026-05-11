"""BFCL-style agent_fn factory backed by the OpenClaw CLI.

BFCL (Berkeley Function-Call Leaderboard) drives the agent with a single
prompt plus an OpenAI-format ``tools=`` array and scores the emitted tool
call. Each invocation maps to one OpenClaw CLI spawn whose result is
distilled to ``{"name": ..., "arguments": ...}``.
"""

from __future__ import annotations

import logging
from typing import Any, Awaitable, Callable

from openclaw_adapter.client import OpenClawClient

logger = logging.getLogger(__name__)


def build_bfcl_agent_fn(
    *,
    client: OpenClawClient | None = None,
    system_prompt: str | None = None,
    model_name: str | None = None,
) -> Callable[[str, list[dict[str, Any]]], Awaitable[dict[str, Any]]]:
    """Build an async BFCL-compatible callable.

    Returned signature::

        async def agent_fn(prompt: str, tools: list[dict]) -> dict

    The returned dict shape mirrors the hermes-adapter / eliza-adapter BFCL
    factories::

        {
            "name": <first tool call name, or "">,
            "arguments": <first tool call args, or {}>,
            "text": <assistant content>,
            "tool_calls": [{"name": str, "arguments": ...}, ...],
            "thought": <reasoning or None>,
        }
    """
    bridge = client or OpenClawClient()

    async def _agent_fn(
        prompt: str,
        tools: list[dict[str, Any]],
    ) -> dict[str, Any]:
        context: dict[str, object] = {"tools": tools or []}
        if system_prompt:
            context["system_prompt"] = system_prompt
        try:
            resp = bridge.send_message(prompt, context=context)
        except Exception as exc:
            logger.exception("[openclaw-bfcl] send_message failed")
            raise RuntimeError("OpenClaw BFCL send_message failed") from exc

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
                        "arguments": entry.get("arguments", {}),
                    }
                )

        first = tool_calls[0] if tool_calls else {"name": "", "arguments": {}}
        result: dict[str, Any] = {
            "name": first["name"],
            "arguments": first["arguments"],
            "text": resp.text,
            "tool_calls": tool_calls,
            "thought": resp.thought,
        }
        if model_name:
            result["model_name"] = model_name
        return result

    return _agent_fn


__all__ = ["build_bfcl_agent_fn"]
