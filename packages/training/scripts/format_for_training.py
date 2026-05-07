"""Render canonical eliza records into Qwen chat-template messages.

The dataset on disk is the flat eliza shape (`SCHEMA.md`). The training-time
system prompt is rendered HERE so the dataset stays compatible with the
elizaOS runtime decoder.

Resolution order for the system prompt:

  1. `metadata.system_prompt`   (carried explicitly by some adapters)
  2. eliza prompt template by   `metadata.task_type` from `data/prompts/registry.json`
  3. a built-in fallback        (TASK_FALLBACK_SYSTEM)

Tool specs from `metadata.toolSpecs` are appended to the system prompt as a
JSON block so the student sees the tool surface inline. We do NOT use Qwen's
tool-calling JSON convention because the student emits TOON.
"""

from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
PROMPT_REGISTRY = ROOT / "data" / "prompts" / "registry.json"


TASK_FALLBACK_SYSTEM = """You are an autonomous elizaOS agent. Decide which
action to take from `availableActions` and respond with ONE TOON document
matching the action's expected schema.

  - REPLY      → emit `thought: ...\\ntext: ...`
  - SHELL_COMMAND → emit `command: <shell>\\nexplanation: <why>`
  - TASK_CALL  → emit `tool_calls[N]{name,arguments}: ...`
  - RESPOND/IGNORE/STOP → emit `name`, `reasoning`, `action`, `primaryContext`,
                          `secondaryContexts`, `evidenceTurnIds`

Always TOON. No fences, no <think>, no prose before or after.""".rstrip()


REPLY_SYSTEM = """You are {agentId}. Respond with ONE TOON document:

thought: a short description of your plan
text: the message to send

Always TOON. No fences, no <think>, no prose before or after.""".rstrip()


# Reasoning-distill records (Kassadin88/Claude-Distills, claude_distill task
# type) ship `<think>...</think>final` verbatim. The system prompt is the
# minimal one used by the adapter; we look up `metadata.system_prompt` first
# so the per-record prompt always wins, and fall back here only if the
# adapter forgot to set it.
CLAUDE_DISTILL_SYSTEM = (
    "You are a helpful, careful assistant. Think step by step inside "
    "<think>...</think> tags before producing your final answer."
)


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
    if task_type == "claude_distill":
        return CLAUDE_DISTILL_SYSTEM

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
    if normalized == "model":
        return "assistant"
    if normalized in ("system", "user", "assistant"):
        return normalized
    return None


def _format_messages_record(
    record: dict[str, Any],
) -> dict[str, list[dict[str, str]]] | None:
    """Accept runtime trajectory/Gemini rows that already carry messages."""

    raw_messages = record.get("messages")
    if not isinstance(raw_messages, list):
        return None

    messages: list[dict[str, str]] = []
    for raw in raw_messages:
        if not isinstance(raw, dict):
            continue
        role = _normalize_message_role(raw.get("role"))
        content = raw.get("content")
        if role is None or not isinstance(content, str) or not content.strip():
            continue
        messages.append({"role": role, "content": content})

    if not messages:
        return None

    if messages[0]["role"] != "system":
        messages.insert(0, {"role": "system", "content": system_prompt_for(record)})

    # Supervised SFT needs an assistant target. Runtime harness rows and
    # Vertex/Gemini rows both place it at the end; reject partial prompt-only
    # rows so they cannot train the model to predict user text.
    if messages[-1]["role"] != "assistant":
        return None

    if not any(message["role"] == "user" for message in messages):
        return None

    return {"messages": messages}


def format_record(record: dict[str, Any]) -> dict[str, list[dict[str, str]]] | None:
    """Return {"messages": [...]} ready for tokenizer.apply_chat_template,
    or None if the record can't be rendered."""

    messages_record = _format_messages_record(record)
    if messages_record is not None:
        return messages_record

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

    messages: list[dict[str, str]] = [{"role": "system", "content": system_prompt}]
    for m in record.get("memoryEntries") or []:
        role = m.get("role") or "user"
        if role not in ("user", "assistant"):
            continue
        content = m.get("content") or ""
        if not content:
            continue
        messages.append({"role": role, "content": content})

    messages.append({"role": "user", "content": cm_content})
    messages.append({"role": "assistant", "content": expected})

    return {"messages": messages}
