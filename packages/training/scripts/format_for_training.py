"""Render Eliza-native trajectory rows for Qwen chat-template training.

The primary input is `eliza_native_v1`: one row per Vercel AI SDK model
boundary with the exact request sent to the provider and the exact normalized
response received from the provider. The renderer appends the response as the
supervised assistant turn and passes native tools through to the tokenizer chat
template when the tokenizer supports tool rendering.

The accepted runtime trajectory input is `eliza_native_v1` only.
"""

from __future__ import annotations

import json
from typing import Any

NATIVE_BOUNDARIES = {"vercel_ai_sdk.generateText", "vercel_ai_sdk.streamText"}


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
    messages: list[dict[str, Any]] = []
    system = request.get("system")
    if isinstance(system, str) and system:
        messages.append({"role": "system", "content": system})

    raw_messages = request.get("messages")
    if isinstance(raw_messages, list):
        parsed_messages = [
            msg
            for raw in raw_messages
            if (msg := _normalize_message(raw)) is not None
        ]
        for msg in parsed_messages:
            if (
                msg.get("role") == "system"
                and messages
                and messages[0].get("role") == "system"
                and messages[0].get("content") == msg.get("content")
            ):
                continue
            messages.append(msg)

    prompt = request.get("prompt")
    if isinstance(prompt, str) and prompt.strip():
        messages.append({"role": "user", "content": prompt})
    return messages


def _format_native_record(record: dict[str, Any]) -> dict[str, Any] | None:
    if record.get("format") != "eliza_native_v1":
        return None
    if record.get("boundary") not in NATIVE_BOUNDARIES:
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


def format_record(record: dict[str, Any]) -> dict[str, Any] | None:
    """Return a row ready for tokenizer.apply_chat_template, or None."""

    return _format_native_record(record)
