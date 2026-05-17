"""Native JSON/function-call validator for the action synthesis harness."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class ValidationResult:
    ok: bool
    reason: str
    cleaned_text: str = ""


_JSON_FENCE_RE = re.compile(r"^```(?:json)?\s*([\s\S]*?)\s*```$", re.I)


def _clean_json_text(text: str) -> str:
    stripped = text.strip()
    match = _JSON_FENCE_RE.match(stripped)
    if match:
        return match.group(1).strip()
    return stripped


def _parse_json_object(text: str) -> dict[str, Any] | None:
    cleaned = _clean_json_text(text)
    if not cleaned:
        return None
    if not cleaned.startswith("{"):
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start < 0 or end <= start:
            return None
        cleaned = cleaned[start : end + 1]
    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _call_name(call: dict[str, Any]) -> str:
    function = call.get("function") if isinstance(call.get("function"), dict) else {}
    value = call.get("toolName") or call.get("name") or function.get("name")
    return value if isinstance(value, str) else ""


def _call_args(call: dict[str, Any]) -> dict[str, Any]:
    function = call.get("function") if isinstance(call.get("function"), dict) else {}
    args = (
        call.get("input")
        if "input" in call
        else call.get("args")
        if "args" in call
        else call.get("arguments")
        if "arguments" in call
        else function.get("arguments")
    )
    if isinstance(args, str):
        try:
            parsed = json.loads(args)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return args if isinstance(args, dict) else {}


def normalize_tool_calls(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    calls: list[dict[str, Any]] = []
    for raw in value:
        if isinstance(raw, dict) and _call_name(raw):
            calls.append({"name": _call_name(raw), "arguments": _call_args(raw)})
    return calls


def extract_tool_calls_from_text(text: str) -> list[dict[str, Any]]:
    parsed = _parse_json_object(text)
    if not parsed:
        return []
    for key in ("toolCalls", "tool_calls"):
        if isinstance(parsed.get(key), list):
            return normalize_tool_calls(parsed[key])
    if _call_name(parsed):
        return normalize_tool_calls([parsed])
    return []


def _cleaned_tool_call_text(tool_calls: list[dict[str, Any]]) -> str:
    return json.dumps(
        {"toolCalls": tool_calls},
        ensure_ascii=False,
        separators=(",", ":"),
    )


def validate(
    *,
    raw_response: str,
    tool_calls: list[dict[str, Any]] | None,
    task_type: str,
    scenario_kind: str,
    expected_action: str,
    expected_arg_keys: list[str],
    catalog_action_names: set[str],
) -> ValidationResult:
    del task_type, catalog_action_names

    normalized_calls = normalize_tool_calls(tool_calls or [])
    if not normalized_calls:
        normalized_calls = extract_tool_calls_from_text(raw_response)

    if scenario_kind == "missing_required":
        if normalized_calls:
            return ValidationResult(False, "called tool despite missing required information")
        text = raw_response.strip()
        if not text:
            return ValidationResult(False, "missing clarifying reply")
        return ValidationResult(True, "clarifying reply", text)

    if not normalized_calls:
        return ValidationResult(False, "missing native tool call")

    matching = [call for call in normalized_calls if call["name"] == expected_action]
    if not matching:
        names = ", ".join(call["name"] for call in normalized_calls)
        return ValidationResult(False, f"wrong tool call: {names or '(none)'}")

    call = matching[0]
    args = call.get("arguments") if isinstance(call.get("arguments"), dict) else {}
    missing = [key for key in expected_arg_keys if key not in args]
    if missing:
        return ValidationResult(False, f"missing expected arg keys: {', '.join(missing)}")

    return ValidationResult(True, "native tool call", _cleaned_tool_call_text([call]))
