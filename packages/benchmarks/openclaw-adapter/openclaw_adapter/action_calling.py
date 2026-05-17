"""Action-calling agent_fn factory backed by the OpenClaw CLI.

action-calling is the native function-calling benchmark for eliza-1: each
record carries a user message plus an OpenAI-style ``tools`` array, and the
benchmark scores the emitted ``tool_calls``. The shape is BFCL-adjacent but
single-record and single-turn; the adapter pushes the prompt through
:class:`OpenClawClient` and returns the model's predicted tool calls.

Each invocation maps to one OpenClaw turn. The returned dict mirrors
``build_bfcl_agent_fn``'s shape so action-calling scoring can read the same
``tool_calls`` field regardless of harness.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Awaitable, Callable

from openclaw_adapter.client import OpenClawClient

logger = logging.getLogger(__name__)


_DEFAULT_SYSTEM_PROMPT = (
    "You are solving an action-calling task. Select one or more of the "
    "provided tools and return native tool_calls with the correct "
    "arguments. If no listed tool is relevant, respond without a tool call."
)


def build_action_calling_agent_fn(
    *,
    client: OpenClawClient | None = None,
    system_prompt: str | None = None,
    model_name: str | None = None,
) -> Callable[[str, list[dict[str, Any]]], Awaitable[dict[str, Any]]]:
    """Build an async action-calling-compatible callable.

    Returned signature::

        async def agent_fn(prompt: str, tools: list[dict]) -> dict

    The returned dict shape matches the BFCL factory so consumers can share
    parsing helpers::

        {
            "text": <assistant content>,
            "tool_calls": [{"id": str, "name": str, "arguments": dict|str}, ...],
            "thought": <reasoning or None>,
            "model_name": <when provided>,
        }
    """
    bridge = client or OpenClawClient(direct_openai_compatible=True)
    effective_system_prompt = system_prompt or _DEFAULT_SYSTEM_PROMPT

    async def _agent_fn(
        prompt: str,
        tools: list[dict[str, Any]],
    ) -> dict[str, Any]:
        context: dict[str, object] = {
            "benchmark": "action_calling",
            "tools": tools or [],
            "tool_choice": "auto",
            "system_prompt": effective_system_prompt,
        }
        try:
            resp = bridge.send_message(prompt, context=context)
        except Exception as exc:
            logger.exception("[openclaw-action-calling] send_message failed")
            raise RuntimeError(
                "OpenClaw action-calling send_message failed"
            ) from exc

        raw_tool_calls = (
            resp.params.get("tool_calls") if isinstance(resp.params, dict) else None
        )
        tool_calls: list[dict[str, Any]] = []
        if isinstance(raw_tool_calls, list):
            for entry in raw_tool_calls:
                if not isinstance(entry, dict):
                    continue
                # Tolerate both the OpenAI nested shape (function.name) and
                # the flat shape (name/arguments) that OpenClawClient emits
                # depending on transport mode.
                fn = entry.get("function") if isinstance(entry.get("function"), dict) else entry
                name_raw = fn.get("name") or entry.get("name")
                if not isinstance(name_raw, str) or not name_raw:
                    continue
                args = fn.get("arguments", entry.get("arguments", {}))
                if isinstance(args, str):
                    try:
                        args = json.loads(args)
                    except json.JSONDecodeError:
                        args = {}
                if not isinstance(args, dict):
                    args = {}
                tool_calls.append(
                    {
                        "id": str(entry.get("id") or f"call_{len(tool_calls)}"),
                        "name": name_raw,
                        "arguments": args,
                    }
                )

        result: dict[str, Any] = {
            "text": resp.text,
            "tool_calls": tool_calls,
            "thought": resp.thought,
        }
        if model_name:
            result["model_name"] = model_name
        return result

    return _agent_fn


__all__ = ["build_action_calling_agent_fn"]
