"""REALM plan parsing helpers."""

from __future__ import annotations

import json
import re
from typing import Any


def _parse_plan_json(text: str, available_tools: list[str]) -> list[dict[str, Any]]:
    """Parse a JSON plan from an LLM response."""
    if not text or not text.strip():
        return []

    json_text: str | None = None
    for pattern in (r"```json\s*(.*?)```", r"```\s*(.*?)```", r"\[\s*\{.*?\}\s*\]"):
        match = re.search(pattern, text, re.DOTALL)
        if match:
            json_text = match.group(1) if "```" in pattern else match.group(0)
            break
    if json_text is None:
        json_text = text

    json_text = json_text.strip()
    if not json_text.startswith("["):
        start = json_text.find("[")
        end = json_text.rfind("]")
        if start != -1 and end != -1:
            json_text = json_text[start : end + 1]
    json_text = re.sub(r",\s*([\]}])", r"\1", json_text)

    try:
        parsed = json.loads(json_text)
    except json.JSONDecodeError:
        return []

    if isinstance(parsed, dict):
        parsed = parsed.get("actions") or parsed.get("plan") or parsed.get("steps")
    if not isinstance(parsed, list):
        return []

    plan: list[dict[str, Any]] = []
    for item in parsed:
        if not isinstance(item, dict):
            continue
        action_name = item.get("action") or item.get("tool") or item.get("name")
        if not isinstance(action_name, str) or action_name not in available_tools:
            continue
        parameters = item.get("parameters", {})
        plan.append(
            {
                "action": action_name,
                "description": str(item.get("description", "")),
                "parameters": parameters if isinstance(parameters, dict) else {},
            }
        )
    return plan
