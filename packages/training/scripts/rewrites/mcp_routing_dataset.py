"""Rewriter for mcp-routing-dataset.

Original shape (mis-classified as `reply`):
    expectedResponse TOON:
        thought: "<outer wrapper thought>"
        text: "{\"thought\": ..., \"tool_calls\": [{\"name\":..., \"parameters\":...}]}"

Target shape (`mcp_tool_call`):
    thought: <prefer outer; fallback to inner>
    tool_calls[N]:
      - name: ...
        arguments: {...}

Records whose inner text is not the expected JSON shape (a small minority of
non-tool replies like "I am a helpful assistant.") are returned as plain
`reply` records with the natural-language text preserved.
"""

from __future__ import annotations

import json
from typing import Any


def _coerce_arguments(raw: Any) -> dict[str, Any]:
    """Inner records use either `parameters` or `arguments`. Normalize to dict."""
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
    if md.get("source_dataset") != "mcp-routing-dataset":
        return record

    try:
        decoded = decoder.decode(record["expectedResponse"])
    except Exception:
        return None
    if not isinstance(decoded, dict):
        return None

    outer_thought = decoded.get("thought") or ""
    raw_text = decoded.get("text")
    if not isinstance(raw_text, str):
        return None

    try:
        inner = json.loads(raw_text)
    except json.JSONDecodeError:
        # Plain natural-language reply — rewrite as `reply` task with the text preserved.
        new_payload = {
            "thought": outer_thought or "Replying directly to the user.",
            "text": raw_text,
        }
        try:
            new_toon = encoder.encode(new_payload)
        except Exception:
            return None
        new_md = dict(md)
        new_md["task_type"] = "reply"
        new_md["_rewriter"] = "mcp_routing_dataset"
        new_md["_rewriter_branch"] = "natural_reply"
        new_record = dict(record)
        new_record["expectedResponse"] = new_toon
        new_record["metadata"] = new_md
        return new_record

    if not isinstance(inner, dict):
        return None

    inner_thought = inner.get("thought") or ""
    raw_calls = inner.get("tool_calls") or []
    if not isinstance(raw_calls, list) or not raw_calls:
        return None

    tool_calls: list[dict[str, Any]] = []
    for entry in raw_calls:
        if not isinstance(entry, dict):
            return None
        name = entry.get("name")
        if not isinstance(name, str) or not name:
            return None
        args_raw = entry.get("parameters", entry.get("arguments"))
        tool_calls.append({"name": name, "arguments": _coerce_arguments(args_raw)})

    new_thought = outer_thought or inner_thought
    if not new_thought:
        return None

    new_payload = {"thought": new_thought, "tool_calls": tool_calls}
    try:
        new_toon = encoder.encode(new_payload)
    except Exception:
        return None

    new_md = dict(md)
    new_md["task_type"] = "mcp_tool_call"
    new_md["_rewriter"] = "mcp_routing_dataset"

    new_record = dict(record)
    new_record["expectedResponse"] = new_toon
    new_record["metadata"] = new_md
    return new_record
