"""Rewriter for agent-trove (`agent_trace` branch).

Original shape:
    expectedResponse native JSON:
        thought: "<rich grounded thought>"
        tool_calls[0] REPLY
        providers: [] (often empty)
        text: "{\"analysis\": ..., \"plan\": ..., \"commands\": [...], \"task_complete\": ...}"
        simple: false

Some records have a `<think>...</think>` wrapper before the JSON; others have
plain natural-language text without the JSON envelope.

Target shape (still `agent_trace`/`message_handler` compatible):
    thought: "<existing>"
    tool_calls[0] REPLY
    providers: []
      text: "<plan body, joined with newlines>"
    simple: true

We drop the `analysis` field (it duplicates the thought) and keep the `plan`
as the textual reply. Top-level `text` is left empty so the runtime renders
the provider text in the canonical message_handler format.

Records that don't carry the JSON envelope and don't have a `<think>` shell
either are passed through unchanged — the existing `text` is already a
plain reply.

Records where the JSON parse fails outright are dropped (return None).
"""

from __future__ import annotations

import json
import re
from typing import Any

_THINK_TAG_RE = re.compile(r"<think>(.*?)</think>", re.DOTALL | re.IGNORECASE)


def _coerce_plan(plan: Any) -> str | None:
    """Turn the inner `plan` field into a single text body."""
    if isinstance(plan, str):
        return plan.strip() or None
    if isinstance(plan, list):
        joined = "\n".join(str(x).strip() for x in plan if str(x).strip())
        return joined or None
    if isinstance(plan, dict):
        # Sometimes plan is a dict with step entries. Render keys: values.
        lines = []
        for k, v in plan.items():
            lines.append(f"{k}: {v}")
        return "\n".join(lines) or None
    return None


def _try_parse_envelope(raw: str) -> dict[str, Any] | None:
    """Strip optional `<think>...</think>` shell and parse the trailing JSON.

    Handles the nested-envelope case where `analysis` itself contains another
    JSON string with the same shape (some records have this layered twice).
    """
    body = _THINK_TAG_RE.sub("", raw).strip()
    if not body:
        return None
    # Strip ```json fenced code-block wrappers if present.
    if body.startswith("```"):
        body = body.lstrip("`").lstrip()
        if body.lower().startswith("json"):
            body = body[4:].lstrip()
        if body.endswith("```"):
            body = body[:-3].rstrip()
    if not body.startswith("{"):
        return None
    try:
        parsed = json.loads(body)
    except json.JSONDecodeError:
        return None
    if not isinstance(parsed, dict):
        return None

    # Unwrap up to two layers of nested {analysis: "<json string>", ...}
    for _ in range(2):
        analysis = parsed.get("analysis")
        plan = parsed.get("plan")
        if isinstance(plan, str) and plan.strip():
            return parsed
        if isinstance(analysis, str) and "{" in analysis:
            inner = _try_parse_envelope(analysis)
            if inner is not None:
                parsed = inner
                continue
        break
    return parsed


def rewrite(record: dict[str, Any], *, decoder, encoder) -> dict[str, Any] | None:
    md = record.get("metadata") or {}
    if md.get("source_dataset") != "agent-trove":
        return record
    if md.get("task_type") != "agent_trace":
        return record

    try:
        decoded = decoder.decode(record["expectedResponse"])
    except Exception:
        return None
    if not isinstance(decoded, dict):
        return None

    thought = decoded.get("thought") or ""
    raw_text = decoded.get("text") or ""
    if not isinstance(raw_text, str):
        return None

    envelope = _try_parse_envelope(raw_text)
    if envelope is None:
        # Plain text — already a reply; keep as is. Nothing to rewrite.
        return record

    plan_text = _coerce_plan(envelope.get("plan"))
    if not plan_text:
        return None

    new_payload: dict[str, Any] = {
        "thought": thought,
        "actions": ["REPLY"],
        "providers": [{"text": plan_text}],
        "text": "",
        "simple": True,
    }

    try:
        new_payload = encoder.encode(new_payload)
    except Exception:
        return None

    new_md = dict(md)
    new_md["_rewriter"] = "agent_trove"

    new_record = dict(record)
    new_record["expectedResponse"] = new_payload
    new_record["metadata"] = new_md
    return new_record
