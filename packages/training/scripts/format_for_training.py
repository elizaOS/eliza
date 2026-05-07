"""Render Eliza-native trajectory rows for Qwen chat-template training.

The primary input is `eliza_native_v1`: one row per Vercel AI SDK model
boundary with the exact request sent to the provider and the exact normalized
response received from the provider. The renderer appends the response as the
supervised assistant turn and passes native tools through to the tokenizer chat
template when the tokenizer supports tool rendering.

Legacy flat ElizaRecord rows are still accepted as a compatibility fallback,
but the runtime trajectory path should use `eliza_native_v1` only.
"""

from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
PROMPT_REGISTRY = ROOT / "data" / "prompts" / "registry.json"


TASK_FALLBACK_SYSTEM = """You are an autonomous elizaOS agent. Use the provided
conversation context and native tools to choose the next action. When tools are
available, call the correct tool with JSON arguments. When no tool is needed,
return the direct assistant response or the requested JSON object.""".rstrip()


REPLY_SYSTEM = "You are {agentId}. Reply directly and use tools only when they are needed."


@lru_cache(maxsize=1)
def _load_prompt_registry() -> dict[str, dict]:
    if not PROMPT_REGISTRY.exists():
        return {}
    payload = json.loads(PROMPT_REGISTRY.read_text(encoding="utf-8"))
    return {e["task_id"]: e for e in payload.get("entries") or []}


HBARS_RE = re.compile(r"\{\{\s*([#/])?([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}")


def render_handlebars(template: str, ctx: dict[str, Any]) -> str:
    def replace(m: re.Match[str]) -> str:
        kind, name = m.group(1), m.group(2)
        if kind in ("#", "/"):
            return ""
        if "." in name:
            head, *rest = name.split(".")
            v: Any = ctx.get(head)
            for k in rest:
                if isinstance(v, dict):
                    v = v.get(k)
                else:
                    v = ""
                    break
            return "" if v is None else str(v)
        return "" if ctx.get(name) is None else str(ctx.get(name))

    return HBARS_RE.sub(replace, template)


TASK_TYPE_ALIASES = {
    "dialogue_routing": "should_respond_with_context",
    "routing": "should_respond_with_context",
    "should_respond": "should_respond",
}


def system_prompt_for(record: dict[str, Any]) -> str:
    md = record.get("metadata") or {}
    explicit = md.get("system_prompt")
    if explicit:
        return str(explicit)

    task_type = md.get("task_type") or ""
    registry = _load_prompt_registry()

    if task_type == "reply":
        return REPLY_SYSTEM.format(agentId=record.get("agentId") or "assistant")

    canonical = TASK_TYPE_ALIASES.get(task_type, task_type)
    entry = registry.get(canonical)
    if entry:
        cm = record.get("currentMessage") or {}
        ctx = {
            "agentName": record.get("agentId") or "assistant",
            "agentId": record.get("agentId") or "assistant",
            "providers": "(no providers)",
            "message": cm.get("content") or "",
            "memoryEntries": record.get("memoryEntries") or [],
            "currentMessage": cm,
            "availableActions": ", ".join(record.get("availableActions") or []),
        }
        return render_handlebars(entry["template"], ctx)

    return TASK_FALLBACK_SYSTEM


def _normalize_message_role(role: Any) -> str | None:
    if not isinstance(role, str):
        return None
    normalized = role.strip().lower()
    if normalized in ("system", "developer", "user", "assistant", "tool"):
        return normalized
    return None


def _has_message_payload(message: dict[str, Any]) -> bool:
    if (
        "parts" in message
        or "tool_calls" in message
        or "tool_call_id" in message
        or "name" in message
    ):
        return True
    if "content" in message:
        content = message.get("content")
        if isinstance(content, str):
            return len(content.strip()) > 0
        return content is not None
    return False


def _normalize_message(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    role = _normalize_message_role(raw.get("role"))
    if role is None:
        return None
    message: dict[str, Any] = {"role": role}
    for key in (
        "content",
        "parts",
        "name",
        "tool_call_id",
        "tool_calls",
    ):
        if key in raw:
            message[key] = raw[key]
    if not _has_message_payload(message):
        return None
    return message


def _json_arguments(value: Any) -> str:
    if isinstance(value, str):
        return value
    if value is None:
        return "{}"
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def _normalize_tool_call(raw: Any, index: int) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None

    function = raw.get("function") if isinstance(raw.get("function"), dict) else {}
    name = (
        raw.get("toolName")
        or raw.get("name")
        or function.get("name")
    )
    if not isinstance(name, str) or not name.strip():
        return None

    args = (
        raw.get("input")
        if "input" in raw
        else raw.get("args")
        if "args" in raw
        else raw.get("arguments")
        if "arguments" in raw
        else function.get("arguments")
    )
    call_id = raw.get("toolCallId") or raw.get("id") or f"call_{index}"
    return {
        "id": str(call_id),
        "type": "function",
        "function": {
            "name": name,
            "arguments": _json_arguments(args),
        },
    }


def _assistant_from_native_response(response: dict[str, Any]) -> dict[str, Any] | None:
    text = response.get("text")
    tool_calls_raw = response.get("toolCalls")
    tool_calls = []
    if isinstance(tool_calls_raw, list):
        tool_calls = [
            call
            for i, raw in enumerate(tool_calls_raw)
            if (call := _normalize_tool_call(raw, i)) is not None
        ]

    if isinstance(text, str) and text.strip():
        message: dict[str, Any] = {"role": "assistant", "content": text}
    elif tool_calls:
        message = {"role": "assistant", "content": ""}
    else:
        return None

    if tool_calls:
        message["tool_calls"] = tool_calls
    return message


def _request_messages(request: dict[str, Any]) -> list[dict[str, Any]]:
    raw_messages = request.get("messages")
    if isinstance(raw_messages, list):
        messages = [
            msg
            for raw in raw_messages
            if (msg := _normalize_message(raw)) is not None
        ]
        if messages:
            return messages

    prompt = request.get("prompt")
    if isinstance(prompt, str) and prompt.strip():
        return [{"role": "user", "content": prompt}]
    return []


def _format_native_record(record: dict[str, Any]) -> dict[str, Any] | None:
    if record.get("format") != "eliza_native_v1":
        return None
    request = record.get("request")
    response = record.get("response")
    if not isinstance(request, dict) or not isinstance(response, dict):
        return None

    messages = _request_messages(request)
    assistant = _assistant_from_native_response(response)
    if not messages or assistant is None:
        return None
    if not any(message.get("role") == "user" for message in messages):
        return None

    out: dict[str, Any] = {"messages": [*messages, assistant]}
    if "tools" in request:
        out["tools"] = request["tools"]
    return out


def _format_messages_record(record: dict[str, Any]) -> dict[str, Any] | None:
    """Accept already-rendered native SFT rows with messages + optional tools."""

    raw_messages = record.get("messages")
    if not isinstance(raw_messages, list):
        return None

    messages = [
        msg
        for raw in raw_messages
        if (msg := _normalize_message(raw)) is not None
    ]
    if not messages:
        return None
    if messages[-1].get("role") != "assistant":
        return None
    if not any(message.get("role") == "user" for message in messages):
        return None

    out: dict[str, Any] = {"messages": messages}
    if "tools" in record:
        out["tools"] = record["tools"]
    return out


def _format_legacy_flat_record(record: dict[str, Any]) -> dict[str, Any] | None:
    expected = record.get("expectedResponse") or ""
    if not expected:
        return None

    cm = record.get("currentMessage") or {}
    cm_content = cm.get("content") or ""
    if not cm_content:
        return None

    system_prompt = system_prompt_for(record)
    md = record.get("metadata") or {}
    tool_specs = md.get("toolSpecs") or []
    if tool_specs:
        system_prompt = (
            system_prompt.rstrip()
            + "\n\nAvailable tools (JSON):\n"
            + json.dumps(tool_specs, ensure_ascii=False, indent=2)
        )

    actions = record.get("availableActions") or []
    if actions:
        system_prompt = (
            system_prompt.rstrip()
            + "\n\nAvailable actions: "
            + ", ".join(str(a) for a in actions)
        )

    messages: list[dict[str, Any]] = [{"role": "system", "content": system_prompt}]
    for m in record.get("memoryEntries") or []:
        role = _normalize_message_role(m.get("role") or "user")
        if role not in ("user", "assistant"):
            continue
        content = m.get("content") or ""
        if not content:
            continue
        messages.append({"role": role, "content": content})

    messages.append({"role": "user", "content": cm_content})
    messages.append({"role": "assistant", "content": expected})
    return {"messages": messages}


def format_record(record: dict[str, Any]) -> dict[str, Any] | None:
    """Return a row ready for tokenizer.apply_chat_template, or None."""

    native = _format_native_record(record)
    if native is not None:
        return native

    messages_record = _format_messages_record(record)
    if messages_record is not None:
        return messages_record

    return _format_legacy_flat_record(record)
