"""Rewriter for openclaw-operator.

Original shape (mis-classified as `agent_trace`):
    expectedResponse native JSON:
        thought: "..."
        text: "[{\"name\":\"foo\",\"arguments\":{...}}, ...]"

Two branches show up in practice:
  - `text` parses as a JSON array of {name, arguments} → re-emit as `tool_call`
    with structured `tool_calls[N]`.
  - `text` is natural-language ("Apologies, but I'm unable...") → re-emit as
    `reply` so we don't strand a JSON-array-of-objects as a chat answer.

Records whose `text` is neither shape are returned as `None`.
"""

from __future__ import annotations

import json
from typing import Any


def _coerce_arguments(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            return {}
        if isinstance(parsed, dict):
            return parsed
    return {}


def rewrite(record: dict[str, Any], *, decoder, encoder) -> dict[str, Any] | None:
    md = record.get("metadata") or {}
    if md.get("source_dataset") != "openclaw-operator":
        return record

    # Only rewrite the agent_trace branch — the small `tool_call` branch
    # already has the canonical shape.
    if md.get("task_type") != "agent_trace":
        return record

    try:
        decoded = decoder.decode(record["expectedResponse"])
    except Exception:
        return None
    if not isinstance(decoded, dict):
        return None

    thought = decoded.get("thought") or ""
    raw_text = decoded.get("text")
    if not isinstance(raw_text, str):
        return None

    branch = "tool_call"
    parsed: Any
    try:
        parsed = json.loads(raw_text)
    except json.JSONDecodeError:
        parsed = None

    if isinstance(parsed, list) and parsed:
        tool_calls: list[dict[str, Any]] = []
        for entry in parsed:
            if not isinstance(entry, dict):
                return None
            name = entry.get("name")
            if not isinstance(name, str) or not name:
                return None
            args_raw = entry.get("arguments", entry.get("parameters"))
            tool_calls.append({"name": name, "arguments": _coerce_arguments(args_raw)})
        if not thought:
            # Synthesize a minimal thought rather than dropping the record;
            # the original outer thought was a synth-time leftover anyway.
            names = ", ".join(call["name"] for call in tool_calls)
            thought = f"Calling {names} to satisfy the user's request."
        new_payload = {"thought": thought, "tool_calls": tool_calls}
        new_task_type = "tool_call"
    else:
        # Natural-language refusal/answer: keep as a `reply`.
        if not raw_text.strip():
            return None
        if not thought:
            thought = "Replying to the user directly."
        new_payload = {"thought": thought, "text": raw_text}
        new_task_type = "reply"
        branch = "natural_reply"

    try:
        new_payload = encoder.encode(new_payload)
    except Exception:
        return None

    new_md = dict(md)
    new_md["task_type"] = new_task_type
    new_md["_rewriter"] = "openclaw_operator"
    new_md["_rewriter_branch"] = branch

    new_record = dict(record)
    new_record["expectedResponse"] = new_payload
    new_record["metadata"] = new_md
    return new_record
