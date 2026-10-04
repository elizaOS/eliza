"""MINT conversation and tool-call protocol shared by native harnesses."""

from __future__ import annotations
import json
from typing import Any

DEFAULT_SYSTEM_PROMPT = (
    "You are solving a MINT multi-turn interactive task. Use the provided "
    "tools to make progress; when you have the final answer, respond with "
    "plain text and no tool call."
)


def history_to_openai_messages(history: list[Any]) -> list[dict[str, Any]]:
    """Convert MINT-style history into OpenAI chat-completions message list.

    Preserves prior assistant ``tool_calls`` and tool result records so the
    model sees its own previous actions plus the runner's observations.
    """
    out: list[dict[str, Any]] = []
    for turn in history or []:
        role = getattr(turn, "role", None) or (
            turn.get("role") if isinstance(turn, dict) else None
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


def last_user_text(messages: list[dict[str, Any]]) -> str:
    for m in reversed(messages):
        if m.get("role") == "user":
            return str(m.get("content") or "")
    return ""


def normalize_tool_calls(raw: object) -> list[dict[str, Any]]:
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
