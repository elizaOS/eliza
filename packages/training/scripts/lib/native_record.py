"""Builder for the canonical `eliza_native_v1` corpus record.

See `docs/dataset/CANONICAL_RECORD.md`. One row = one Vercel AI SDK
`generateText` model-call boundary: the exact request and the normalized
response. This is the only shape new synthesized datasets should emit.

Two response shapes occur in the wild:

1. **Native tool-call planner output.** `response.text` carries the live
   planner JSON envelope (`{thought, toolCalls:[{id?,name,args}],
   messageToUser?}`) and `response.toolCalls` mirrors the calls in AI-SDK
   form (`{toolCallId, toolName, input}`). Use `native_tool_call_record`.
2. **Plain structured/handler output.** A single-turn LLM call whose
   response is a JSON object (fact ops, summary, reflection, extracted
   option, ...) or plain assistant text. `response.text` is the verbatim
   model output, no `toolCalls`. Use `native_text_record`.

Identity/bookkeeping fields (`trajectoryId`, `agentId`, ...) are optional
per the canonical doc; synthetic rows carry `metadata` only.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

FORMAT = "eliza_native_v1"
BOUNDARY_GENERATE_TEXT = "vercel_ai_sdk.generateText"
SCHEMA_VERSION = 1


def stable_id(*parts: object) -> str:
    h = hashlib.sha256()
    for p in parts:
        h.update(json.dumps(p, sort_keys=True, default=str, ensure_ascii=False).encode("utf-8"))
        h.update(b"\x00")
    return h.hexdigest()[:24]


def _messages(system: str | None, turns: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for t in turns:
        role = t.get("role")
        if role not in {"system", "user", "assistant", "tool"}:
            raise ValueError(f"invalid message role: {role!r}")
        msg: dict[str, Any] = {"role": role, "content": t["content"]}
        if role == "tool" and t.get("tool_call_id"):
            msg["tool_call_id"] = t["tool_call_id"]
        out.append(msg)
    if not any(m["role"] == "user" for m in out):
        raise ValueError("eliza_native_v1 request.messages needs at least one user turn")
    return out


def _base_record(
    *,
    system: str | None,
    messages: list[dict[str, Any]],
    response: dict[str, Any],
    tools: list[dict[str, Any]] | None,
    metadata: dict[str, Any] | None,
    settings: dict[str, Any] | None,
) -> dict[str, Any]:
    request: dict[str, Any] = {"messages": messages}
    if system:
        request["system"] = system
    if tools:
        request["tools"] = tools
    request["settings"] = settings or {"temperature": 0.0, "topP": 1.0}
    rec: dict[str, Any] = {
        "format": FORMAT,
        "schemaVersion": SCHEMA_VERSION,
        "boundary": BOUNDARY_GENERATE_TEXT,
        "request": request,
        "response": response,
    }
    if metadata:
        rec["metadata"] = metadata
    return rec


def native_text_record(
    *,
    system: str | None,
    user: str | dict[str, Any] | list[dict[str, Any]],
    response_text: str,
    metadata: dict[str, Any] | None = None,
    tools: list[dict[str, Any]] | None = None,
    settings: dict[str, Any] | None = None,
    extra_turns: list[dict[str, Any]] | None = None,
    finish_reason: str = "stop",
) -> dict[str, Any]:
    """A single structured/handler-style model call.

    `user` may be a plain string (one user turn), a single message dict, or
    a full pre-built message list (in which case `extra_turns` is ignored).
    `response_text` is the verbatim model output (JSON object string for
    structured handlers, plain text for replies).
    """
    if isinstance(user, list):
        turns = list(user)
    else:
        turns = list(extra_turns or [])
        turns.append(user if isinstance(user, dict) else {"role": "user", "content": user})
    messages = _messages(system, turns)
    response = {"text": response_text, "finishReason": finish_reason}
    return _base_record(
        system=system,
        messages=messages,
        response=response,
        tools=tools,
        metadata=metadata,
        settings=settings,
    )


def native_tool_call_record(
    *,
    system: str | None,
    turns: list[dict[str, Any]],
    thought: str,
    tool_calls: list[dict[str, Any]] | None = None,
    message_to_user: str | None = None,
    metadata: dict[str, Any] | None = None,
    tools: list[dict[str, Any]] | None = None,
    settings: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """A planner-stage model call whose response is the native planner envelope.

    `tool_calls` entries are `{name, args, id?}`. The envelope JSON goes in
    `response.text`; `response.toolCalls` carries the AI-SDK mirror.
    """
    calls = tool_calls or []
    envelope: dict[str, Any] = {"thought": thought, "toolCalls": []}
    sdk_calls: list[dict[str, Any]] = []
    for i, c in enumerate(calls):
        name = c["name"]
        args = c.get("args", {}) or {}
        cid = c.get("id") or f"call_{i}"
        envelope["toolCalls"].append({"id": cid, "name": name, "args": args})
        sdk_calls.append({"toolCallId": cid, "toolName": name, "input": args})
    if message_to_user is not None:
        envelope["messageToUser"] = message_to_user
    response: dict[str, Any] = {
        "text": json.dumps(envelope, ensure_ascii=False, separators=(",", ":")),
        "finishReason": "tool_calls" if sdk_calls else "stop",
    }
    if sdk_calls:
        response["toolCalls"] = sdk_calls
    return _base_record(
        system=system,
        messages=_messages(system, turns),
        response=response,
        tools=tools,
        metadata=metadata,
        settings=settings,
    )


def validate_native_record(rec: dict[str, Any]) -> tuple[bool, str]:
    """Mirror `format_for_training._format_native_record`'s acceptance gate."""
    if not isinstance(rec, dict):
        return False, "not a dict"
    if rec.get("format") != FORMAT:
        return False, f"format != {FORMAT}"
    if rec.get("boundary") not in {BOUNDARY_GENERATE_TEXT, "vercel_ai_sdk.streamText"}:
        return False, f"bad boundary {rec.get('boundary')!r}"
    req = rec.get("request")
    if not isinstance(req, dict):
        return False, "request not a dict"
    messages = req.get("messages")
    if isinstance(messages, list):
        if not any(isinstance(m, dict) and m.get("role") == "user" for m in messages):
            return False, "request.messages has no user turn"
    elif not isinstance(req.get("prompt"), str) or not req["prompt"].strip():
        return False, "request has neither messages nor prompt"
    resp = rec.get("response")
    if not isinstance(resp, dict):
        return False, "response not a dict"
    has_text = isinstance(resp.get("text"), str) and resp["text"].strip() != ""
    has_calls = isinstance(resp.get("toolCalls"), list) and len(resp["toolCalls"]) > 0
    if not (has_text or has_calls):
        return False, "response has neither text nor toolCalls"
    return True, ""


def write_jsonl(records, path) -> int:
    from pathlib import Path

    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with p.open("w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
            n += 1
    return n
