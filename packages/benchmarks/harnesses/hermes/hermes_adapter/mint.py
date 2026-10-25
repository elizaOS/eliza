"""MINT agent_fn factory backed by hermes-agent.

MINT (Multi-turn INTeractive) is a multi-turn benchmark that drives an
agent through math/code tasks with intermediate tool/code execution. Each
turn the runner provides the dialog history and the agent emits one of:

  * a code/tool action — surfaced as ``tool_calls``
  * a final answer — surfaced as ``text`` (no tool_calls)

This adapter wraps :class:`HermesClient` and threads the conversation
history through ``send_message(text, context={"messages": ...})``. Mirrors
the OpenClaw and Eliza MINT factories so the runner reads the same shape
across harnesses.
"""

from __future__ import annotations

from benchmarks.suites.mint import (
    history_to_openai_messages as _history_to_openai_messages,
    last_user_text as _last_user_text,
    normalize_tool_calls as _normalize_tool_calls,
    DEFAULT_SYSTEM_PROMPT as _DEFAULT_SYSTEM_PROMPT,
)

import logging
import time
from typing import Any, Awaitable, Callable

from hermes_adapter.client import HermesClient

logger = logging.getLogger(__name__)


def build_mint_agent_fn(
    *,
    client: HermesClient | None = None,
    system_prompt: str | None = None,
    model_name: str | None = None,
) -> Callable[[list[Any], list[dict[str, Any]]], Awaitable[dict[str, Any]]]:
    """Build an async MINT-compatible callable.

    Returned signature::

        async def agent_fn(history: list, tools: list[dict]) -> dict

    The returned dict shape::

        {
            "role": "assistant",
            "text": <assistant content>,
            "tool_calls": [{"id", "type", "function": {"name", "arguments"}}, ...],
            "thought": <reasoning or None>,
            "latency_ms": int,
            "model_name": <when provided>,
        }
    """
    bridge = client or HermesClient()
    bridge.wait_until_ready(timeout=60)
    effective_system_prompt = system_prompt or _DEFAULT_SYSTEM_PROMPT

    async def _agent_fn(
        history: list[Any],
        tools: list[dict[str, Any]],
    ) -> dict[str, Any]:
        messages = _history_to_openai_messages(history)
        if not any(m.get("role") == "user" for m in messages):
            return {
                "role": "assistant",
                "text": "",
                "tool_calls": [],
                "thought": None,
            }
        if effective_system_prompt and not any(
            m.get("role") == "system" for m in messages
        ):
            messages.insert(0, {"role": "system", "content": effective_system_prompt})

        last_user = _last_user_text(messages)
        context: dict[str, object] = {
            "benchmark": "mint",
            "messages": messages,
        }
        if tools:
            context["tools"] = tools
            context["tool_choice"] = "auto"

        start_ns = time.monotonic_ns()
        try:
            resp = bridge.send_message(last_user, context=context)
        except Exception as exc:
            logger.exception("[hermes-mint] send_message failed")
            raise RuntimeError("hermes MINT send_message failed") from exc
        latency_ms = (time.monotonic_ns() - start_ns) // 1_000_000

        raw_tool_calls = (
            resp.params.get("tool_calls") if isinstance(resp.params, dict) else None
        )
        tool_calls = _normalize_tool_calls(raw_tool_calls)

        result: dict[str, Any] = {
            "role": "assistant",
            "text": resp.text,
            "tool_calls": tool_calls,
            "thought": resp.thought,
            "latency_ms": int(latency_ms),
        }
        if model_name:
            result["model_name"] = model_name
        return result

    return _agent_fn


__all__ = ["build_mint_agent_fn"]
