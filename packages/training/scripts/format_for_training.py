"""Render Eliza-1 training rows for Qwen chat-template training.

The primary input is `eliza_native_v1`: one row per Vercel AI SDK model
boundary with the exact request sent to the provider and the exact normalized
response received from the provider. The renderer appends the response as the
supervised assistant turn and passes native tools through to the tokenizer chat
template when the tokenizer supports tool rendering.

Compatibility inputs are accepted so local and Vast runs can consume the
existing root `train.jsonl` / `val.jsonl` / `test.jsonl` handoff:

* trainable `eliza.eliza1_trajectory_record.v1` message rows,
* already-rendered chat-message rows with a final assistant turn,
* legacy flat `ElizaRecord` rows emitted by `pack_dataset.py`.

Auxiliary repair/eval rows are intentionally rejected.

Privacy contract
----------------
Every record emitted from `format_record` is passed through the canonical
Python port of the app-training privacy filter
(`privacy_filter_trajectories.redact_value`) before it leaves this module.
The filter is loaded at import time; if the import or pattern compile fails,
the script errors out rather than silently writing unfiltered data. See
`packages/training/AGENTS.md` and the repo-wide CLAUDE.md privacy clause —
the database stores raw user data intentionally; redaction lives on the
outbound (export / training / HF publish) path, and this module is one of
the load-bearing barriers.
"""

from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
PROMPT_REGISTRY = ROOT / "data" / "prompts" / "registry.json"

NATIVE_FORMAT = "eliza_native_v1"

# Mandatory privacy filter — every record must pass through this before
# JSONL write. Importing eagerly means a broken filter aborts the script;
# there is no bypass path.
from privacy_filter_trajectories import (  # noqa: E402
    PrivacyFilterError,
    redact_value as _redact_value,
)

# Force pattern compile at import time so any failure surfaces here, not
# at first record. `_inline_patterns()` raises `PrivacyFilterError` on
# empty/failed compile; let it propagate.
from privacy_filter_trajectories import _inline_patterns as _compile_inline_patterns  # noqa: E402

try:
    _compile_inline_patterns()
except PrivacyFilterError:
    raise
except Exception as exc:  # pragma: no cover - safety net for unexpected errors
    raise PrivacyFilterError(
        f"format_for_training: failed to compile privacy filter patterns: {exc}"
    ) from exc

NATIVE_BOUNDARIES = {"vercel_ai_sdk.generateText", "vercel_ai_sdk.streamText"}
ELIZA1_TRAJECTORY_RECORD_SCHEMA = "eliza.eliza1_trajectory_record.v1"
TRAINABLE_SPLITS = {"train", "val", "validation", "test"}
AUXILIARY_SPLITS = {"repair", "repair_eval"}

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
    explicit = md.get("system_prompt") if isinstance(md, dict) else None
    if explicit:
        return str(explicit)

    task_type = md.get("task_type") if isinstance(md, dict) else ""
    task_type = task_type or ""
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


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _clean_string(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _record_split(record: dict[str, Any]) -> str:
    split = _clean_string(record.get("split")).lower()
    if split:
        return split
    metadata = _as_dict(record.get("metadata"))
    return _clean_string(metadata.get("split")).lower()


def _record_quality(record: dict[str, Any]) -> dict[str, Any]:
    quality = record.get("quality")
    if isinstance(quality, dict):
        return quality
    metadata = _as_dict(record.get("metadata"))
    return _as_dict(metadata.get("quality"))


def _is_auxiliary_record(record: dict[str, Any]) -> bool:
    split = _record_split(record)
    if split in AUXILIARY_SPLITS:
        return True
    quality = _record_quality(record)
    return (
        quality.get("success") is False
        or quality.get("requiresRepair") is True
        or quality.get("rating") == "repair"
    )


def _normalize_message_role(role: Any) -> str | None:
    if not isinstance(role, str):
        return None
    normalized = role.strip().lower()
    if normalized == "model":
        return "assistant"
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
    ):
        if key in raw:
            message[key] = raw[key]
    raw_tool_calls = raw.get("tool_calls")
    if raw_tool_calls is None:
        raw_tool_calls = raw.get("toolCalls")
    if isinstance(raw_tool_calls, list):
        tool_calls = [
            call
            for i, call_raw in enumerate(raw_tool_calls)
            if (call := _normalize_tool_call(call_raw, i)) is not None
        ]
        if tool_calls:
            message["tool_calls"] = tool_calls
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
    if record.get("format") != NATIVE_FORMAT:
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


def _format_messages_record(record: dict[str, Any]) -> dict[str, Any] | None:
    """Accept trainable message SFT rows with optional native tool specs."""

    if record.get("schema") == ELIZA1_TRAJECTORY_RECORD_SCHEMA:
        split = _record_split(record)
        if split and split not in TRAINABLE_SPLITS:
            return None
        target = _as_dict(record.get("target"))
        if target and target.get("sftFormat") != "messages":
            return None

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
    if not isinstance(expected, str) or not expected.strip():
        return None

    cm = record.get("currentMessage") or {}
    if not isinstance(cm, dict):
        return None
    cm_content = cm.get("content") or ""
    if not isinstance(cm_content, str) or not cm_content.strip():
        return None

    system_prompt = system_prompt_for(record)
    md = record.get("metadata") or {}
    if not isinstance(md, dict):
        md = {}
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
    for raw in record.get("memoryEntries") or []:
        if not isinstance(raw, dict):
            continue
        role = _normalize_message_role(raw.get("role") or "user")
        if role not in ("user", "assistant"):
            continue
        content = raw.get("content") or ""
        if not isinstance(content, str) or not content.strip():
            continue
        messages.append({"role": role, "content": content})

    messages.append({"role": "user", "content": cm_content})
    messages.append({"role": "assistant", "content": expected})
    return {"messages": messages}


def format_record(record: dict[str, Any]) -> dict[str, Any] | None:
    """Return a row ready for tokenizer.apply_chat_template, or None.

    The returned row is run through the privacy filter before it leaves this
    function. Callers must NOT bypass `format_record` to write training
    rows; this is the single chokepoint that guarantees redaction.
    """

    if _is_auxiliary_record(record):
        return None

    formatted = (
        _format_native_record(record)
        or _format_messages_record(record)
        or _format_legacy_flat_record(record)
    )
    if formatted is None:
        return None
    redacted = _redact_value(formatted)
    if not isinstance(redacted, dict):
        raise PrivacyFilterError(
            "privacy filter returned non-dict for formatted record"
        )
    return redacted
