"""BFCL tool naming and response records shared by native harnesses."""

from __future__ import annotations

import json
import re
from copy import deepcopy
from hashlib import sha1
from typing import Any

from .types import ArgumentValue, FunctionCall

_SAFE_TOOL_NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def coerce_arguments(raw: object) -> dict[str, "ArgumentValue"]:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError("BFCL tool arguments must be a JSON object") from exc
    if not isinstance(raw, dict):
        raise ValueError("BFCL tool arguments must be an object")

    def _norm(value: object) -> "ArgumentValue":
        if value is None or isinstance(value, (str, int, float, bool)):
            return value
        if isinstance(value, list):
            return [_norm(v) for v in value]
        if isinstance(value, dict):
            return {str(k): _norm(v) for k, v in value.items()}
        return str(value)

    return {str(k): _norm(v) for k, v in raw.items()}


def iter_call_records(raw: object) -> list[dict[str, object]]:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            return []
    if isinstance(raw, list):
        return [item for item in raw if isinstance(item, dict)]
    if isinstance(raw, dict):
        calls = raw.get("calls") or raw.get("tool_calls")
        if calls is not None:
            return iter_call_records(calls)
        return [raw]
    return []


def call_from_record(entry: dict[str, object]) -> "FunctionCall | None":
    record: dict[str, object] = entry
    function = entry.get("function")
    if isinstance(function, dict):
        record = function
    name_raw = (
        record.get("name") or record.get("tool_name") or record.get("function_name")
    )
    if not isinstance(name_raw, str) or not name_raw:
        return None
    args_raw = record.get("arguments", record.get("parameters", record.get("args", {})))
    return FunctionCall(name=name_raw, arguments=coerce_arguments(args_raw))


def provider_safe_tool_name(name: str, used: set[str]) -> str:
    if _SAFE_TOOL_NAME_RE.match(name) and name not in used:
        used.add(name)
        return name

    candidate = re.sub(r"[^A-Za-z0-9_-]", "_", name).strip("_")
    if not candidate:
        candidate = "bfcl_tool"
    if not re.match(r"^[A-Za-z0-9_]", candidate):
        candidate = f"bfcl_{candidate}"
    if len(candidate) > 64:
        digest = sha1(name.encode("utf-8")).hexdigest()[:8]
        candidate = f"{candidate[:55]}_{digest}"
    base = candidate
    index = 2
    while candidate in used:
        suffix = f"_{index}"
        candidate = f"{base[: 64 - len(suffix)]}{suffix}"
        index += 1
    used.add(candidate)
    return candidate


def provider_safe_tools(
    tools: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, str]]:
    used: set[str] = set()
    name_map: dict[str, str] = {}
    patched = deepcopy(tools)
    for tool in patched:
        function = tool.get("function")
        if not isinstance(function, dict):
            continue
        original = function.get("name")
        if not isinstance(original, str) or not original:
            continue
        safe = provider_safe_tool_name(original, used)
        name_map[safe] = original
        if safe == original:
            continue
        function["name"] = safe
        description = str(function.get("description") or "")
        hint = f"Original BFCL function name: {original}."
        function["description"] = (
            description if hint in description else f"{description} {hint}".strip()
        )
    return patched, name_map


def restore_original_call_names(
    calls: list["FunctionCall"],
    name_map: dict[str, str],
) -> list["FunctionCall"]:
    if not name_map:
        return calls
    return [
        FunctionCall(name=name_map.get(call.name, call.name), arguments=call.arguments)
        for call in calls
    ]
