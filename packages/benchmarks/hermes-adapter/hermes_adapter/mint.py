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

import json
import logging
import time
from typing import Any, Awaitable, Callable

from hermes_adapter.client import HermesClient

logger = logging.getLogger(__name__)


_DEFAULT_SYSTEM_PROMPT = (
    "You are solving a MINT multi-turn interactive task. Use the provided "
    "tools to make progress; when you have the final answer, respond with "
    "plain text and no tool call."
)


def _history_to_openai_messages(history: list[Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for turn in history or []:
        role = (
            getattr(turn, "role", None)
            or (turn.get("role") if isinstance(turn, dict) else None)
        )
        if role not in {"system", "user", "assistant", "tool"}:
            continue
        content = (
            getattr(turn, "content", None)
            if not isinstance(turn, dict)
            else turn.get("content")
        )
        item: dict[str, Any] = {
            "role": role,
            "content": "" if content is None else str(content),
        }
        if role == "assistant":
            tcs = (
                getattr(turn, "tool_calls", None)
                if not isinstance(turn, dict)
                else turn.get("tool_calls")
            )
            if isinstance(tcs, list) and tcs:
                item["tool_calls"] = tcs
                if not item["content"]:
                    item["content"] = None
        elif role == "tool":
            tcid = (
                getattr(turn, "tool_call_id", None)
                if not isinstance(turn, dict)
                else (turn.get("tool_call_id") or turn.get("toolCallId"))
            )
            if isinstance(tcid, str) and tcid:
                item["tool_call_id"] = tcid
            tname = (
                getattr(turn, "name", None)
                if not isinstance(turn, dict)
                else turn.get("name")
            )
            if isinstance(tname, str) and tname:
                item["name"] = tname
        out.append(item)
    return out


def _last_user_text(messages: list[dict[str, Any]]) -> str:
    for m in reversed(messages):
        if m.get("role") == "user":
            return str(m.get("content") or "")
    return ""


def _normalize_tool_calls(raw: object) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        fn = entry.get("function") if isinstance(entry.get("function"), dict) else entry
        name = str(fn.get("name") or entry.get("name") or "")
        if not name:
            continue
        args = fn.get("arguments", entry.get("arguments", {}))
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except json.JSONDecodeError:
                args = {}
        if not isinstance(args, dict):
            args = {}
        out.append(
            {
                "id": str(entry.get("id") or f"call_{len(out)}"),
                "type": "function",
                "function": {"name": name, "arguments": args},
            }
        )
    return out


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
