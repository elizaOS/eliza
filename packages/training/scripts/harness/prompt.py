"""Canonical message + system-prompt builder for the harness.

Renders the runtime's `message_handler` template (the only catalog template
that handles action routing) using the existing handlebars helper from
`scripts/format_for_training.py` so the rendered system prompt matches
what the trainer would produce later.

`tool_call` mode reuses the same template (the runtime emits a `message_handler`
output regardless of whether the action wraps a TASK_CALL or a direct
named action). The harness records carry `metadata.task_type = "message_handler"`
so the existing `format_for_training.system_prompt_for` resolution path
works without modification.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

# allow `from scripts.lib...` and helpers from sibling files
ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.format_for_training import render_handlebars, _load_prompt_registry  # noqa: E402

from .personas import Persona  # noqa: E402


CANONICAL_CONTROL_ACTIONS = ("REPLY", "IGNORE", "STOP", "RESPOND")


def system_prompt_for_action(
    *,
    agent_id: str,
    action_name: str,
    available_actions: list[str],
    tool_specs: list[dict[str, Any]],
    providers_block: str = "(no providers)",
) -> str:
    """Render the message_handler template + tool_specs + actions list.

    Mirrors what `scripts/format_for_training.format_record` would assemble
    at training time so the harness is bit-identical.
    """
    registry = _load_prompt_registry()
    entry = registry.get("message_handler")
    if not entry:
        raise RuntimeError("message_handler entry missing from prompt registry")

    ctx = {
        "agentName": agent_id,
        "agentId": agent_id,
        "providers": providers_block,
        "availableActions": ", ".join(available_actions),
        "message": "",
        "memoryEntries": [],
        "currentMessage": {},
    }
    rendered = render_handlebars(entry["template"], ctx)
    if tool_specs:
        rendered = (
            rendered.rstrip()
            + "\n\nAvailable tools (JSON):\n"
            + json.dumps(tool_specs, ensure_ascii=False, indent=2)
        )
    if available_actions:
        rendered = (
            rendered.rstrip()
            + "\n\nAvailable actions: "
            + ", ".join(available_actions)
        )
    return rendered


def build_tool_specs(action: dict[str, Any]) -> list[dict[str, Any]]:
    """One-element toolSpecs list for a single catalog action."""
    return [{
        "name": action["name"],
        "description": action.get("description") or "",
        "parameters": action.get("parameters") or [],
    }]


def visible_actions_for(action: dict[str, Any], catalog: list[dict[str, Any]]) -> list[str]:
    """Action set surfaced to the planner: this plugin's actions + canonical
    REPLY / IGNORE / STOP. RESPOND is omitted because it's not in the runtime
    available-actions list for chat-handler turns."""
    plugin = action.get("plugin")
    same_plugin = sorted({a["name"] for a in catalog if a.get("plugin") == plugin})
    out: list[str] = []
    for n in same_plugin:
        if n not in out:
            out.append(n)
    for n in ("REPLY", "IGNORE", "STOP"):
        if n not in out:
            out.append(n)
    return out


def build_user_messages(
    *,
    persona: Persona,
    user_message: str,
    system_prompt: str,
) -> list[dict[str, str]]:
    """Build the chat-completion messages list.

    The system prompt is everything the trainer would render. memoryEntries
    are prepended verbatim. The current user message goes last.
    """
    msgs: list[dict[str, str]] = [{"role": "system", "content": system_prompt}]
    for m in persona.memory_entries:
        role = m.get("role") or "user"
        if role not in ("user", "assistant"):
            continue
        content = m.get("content") or ""
        if content:
            msgs.append({"role": role, "content": content})
    msgs.append({"role": "user", "content": user_message})
    return msgs


def build_canonical_record(
    *,
    persona: Persona,
    action: dict[str, Any],
    catalog: list[dict[str, Any]],
    user_message: str,
    system_prompt: str,
    available_actions: list[str],
    tool_specs: list[dict[str, Any]],
    expected_response: str,
    scenario_kind: str,
    expected_action: str,
    expected_arg_keys: list[str],
    task_type: str = "message_handler",
    channel: str = "chat",
) -> dict[str, Any]:
    """Construct the canonical eliza record dict ready to JSONL-serialize."""
    md = {
        "task_type": task_type,
        "source_dataset": f"harness/{action['name']}",
        "license": "synthetic",
        "split": "train",
        "system_prompt": system_prompt,
        "toolSpecs": tool_specs,
        "harness_action": action["name"],
        "harness_plugin": action.get("plugin"),
        "harness_persona": persona.name,
        "harness_language": persona.language,
        "harness_register": persona.register,
        "harness_scenario_kind": scenario_kind,
        "harness_expected_action": expected_action,
        "harness_expected_arg_keys": expected_arg_keys,
    }
    return {
        "roomName": "harness-room",
        "agentId": "milady",
        "memoryEntries": [
            {
                "role": m.get("role") or "user",
                "speaker": m.get("speaker") or persona.name,
                "content": m.get("content") or "",
                "channel": m.get("channel") or channel,
            }
            for m in persona.memory_entries
        ],
        "currentMessage": {
            "role": "user",
            "speaker": persona.name,
            "content": user_message,
            "channel": channel,
        },
        "expectedResponse": expected_response,
        "availableActions": list(available_actions),
        "metadata": md,
    }
