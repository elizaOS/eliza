"""BFCL tool schema helpers.

This module provides the small adapter surface used by the BFCL runner and
the shared eliza benchmark bridge. It intentionally avoids depending on an
elizaOS runtime so mock and smoke-test paths can import cleanly.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from benchmarks.bfcl.types import FunctionCall, FunctionDefinition


_JSON_SCHEMA_TYPE_ALIASES = {
    "boolean": "boolean",
    "bool": "boolean",
    "dict": "object",
    "double": "number",
    "float": "number",
    "integer": "integer",
    "int": "integer",
    "list": "array",
    "none": "null",
    "number": "number",
    "object": "object",
    "str": "string",
    "string": "string",
    "tuple": "array",
}

_UNCONSTRAINED_SCHEMA_TYPES = {"any"}


def _normalize_schema(schema: Any) -> Any:
    """Convert BFCL/Python-ish schema fragments to JSON Schema types."""
    if isinstance(schema, list):
        return [_normalize_schema(item) for item in schema]
    if not isinstance(schema, dict):
        return schema

    normalized: dict[str, Any] = {}
    normalized_type: str | list[str] | None = None
    for key, value in schema.items():
        if key == "type":
            if isinstance(value, str):
                type_name = value.lower()
                if type_name in _UNCONSTRAINED_SCHEMA_TYPES:
                    continue
                normalized_type = _JSON_SCHEMA_TYPE_ALIASES.get(type_name, "string")
                normalized[key] = normalized_type
            elif isinstance(value, list):
                normalized_types = [
                    _JSON_SCHEMA_TYPE_ALIASES.get(str(item).lower(), "string")
                    for item in value
                    if str(item).lower() not in _UNCONSTRAINED_SCHEMA_TYPES
                ]
                if normalized_types:
                    normalized_type = normalized_types
                    normalized[key] = normalized_type
            else:
                normalized[key] = value
        elif key in {"items", "properties", "additionalProperties"}:
            normalized[key] = _normalize_schema(value)
        else:
            normalized[key] = _normalize_schema(value)

    # BFCL contains Python-ish fragments such as {"type": "string",
    # "items": {"type": "string"}} for list fields. Strict OpenAI-compatible
    # providers reject that invalid JSON Schema. Prefer the structural hints
    # over the stale scalar type so the schema remains scoreable.
    if "properties" in normalized:
        normalized["type"] = "object"
        normalized_type = "object"
    elif "items" in normalized:
        normalized["type"] = "array"
        normalized_type = "array"

    if normalized_type != "array":
        normalized.pop("items", None)
    elif "items" not in normalized:
        normalized["items"] = {}

    if normalized_type != "object":
        normalized.pop("properties", None)
        normalized.pop("additionalProperties", None)
    return normalized


def _coerce_default(schema_type: str | None, default: Any) -> Any:
    """Return a default only when it is valid for the JSON Schema type."""
    if default is None:
        return None
    if schema_type == "boolean":
        if isinstance(default, bool):
            return default
        if isinstance(default, str):
            lowered = default.strip().lower()
            if lowered in {"true", "false"}:
                return lowered == "true"
        return None
    if schema_type == "integer":
        if isinstance(default, bool):
            return None
        if isinstance(default, int):
            return default
        if isinstance(default, str):
            try:
                return int(default)
            except ValueError:
                return None
        return None
    if schema_type == "number":
        if isinstance(default, bool):
            return None
        if isinstance(default, (int, float)):
            return default
        if isinstance(default, str):
            try:
                return float(default)
            except ValueError:
                return None
        return None
    if schema_type == "array":
        return default if isinstance(default, list) else None
    if schema_type == "object":
        return default if isinstance(default, dict) else None
    if schema_type == "string":
        return default if isinstance(default, str) else str(default)
    return default


def _json_schema_for_function(function: FunctionDefinition) -> dict[str, Any]:
    properties: dict[str, Any] = {}
    for name, parameter in function.parameters.items():
        schema: dict[str, Any] = {
            "description": parameter.description,
        }
        param_type = (parameter.param_type or "string").lower()
        schema_type: str | None = None
        if parameter.properties is not None:
            schema_type = "object"
        elif parameter.items is not None:
            schema_type = "array"
        elif param_type not in _UNCONSTRAINED_SCHEMA_TYPES:
            schema_type = _JSON_SCHEMA_TYPE_ALIASES.get(param_type, "string")
        if schema_type is not None:
            schema["type"] = schema_type
        if parameter.enum is not None:
            schema["enum"] = parameter.enum
        default = _coerce_default(schema_type, parameter.default)
        if default is not None:
            schema["default"] = default
        if schema_type == "array" and parameter.items is not None:
            schema["items"] = _normalize_schema(parameter.items)
        if schema_type == "object" and parameter.properties is not None:
            schema["properties"] = _normalize_schema(parameter.properties)
        properties[name] = schema

    return {
        "type": "object",
        "properties": properties,
        "required": list(function.required_params),
    }


def generate_function_schema(function: FunctionDefinition) -> dict[str, Any]:
    """Return an OpenAI-compatible function schema for one BFCL function."""
    return {
        "name": function.name,
        "description": function.description,
        "parameters": _json_schema_for_function(function),
    }


def generate_openai_tools_format(functions: list[FunctionDefinition]) -> list[dict[str, Any]]:
    """Return function definitions in OpenAI ``tools`` format."""
    return [
        {
            "type": "function",
            "function": generate_function_schema(function),
        }
        for function in functions
    ]


@dataclass
class FunctionCallCapture:
    """Simple in-memory capture used by tests and lightweight integrations."""

    calls: list[FunctionCall] = field(default_factory=list)

    def record(self, call: FunctionCall) -> None:
        self.calls.append(call)

    def clear(self) -> None:
        self.calls.clear()

    def get_calls(self) -> list[FunctionCall]:
        return list(self.calls)


_GLOBAL_CAPTURE = FunctionCallCapture()


def get_call_capture() -> FunctionCallCapture:
    return _GLOBAL_CAPTURE


def create_function_action(function: FunctionDefinition) -> dict[str, Any]:
    """Create a runtime-neutral action descriptor for a BFCL function."""
    return {
        "name": function.name,
        "description": function.description,
        "schema": generate_function_schema(function),
    }


class BFCLPluginFactory:
    """Runtime-neutral factory for BFCL function action descriptors."""

    def create_actions(self, functions: list[FunctionDefinition]) -> list[dict[str, Any]]:
        return [create_function_action(function) for function in functions]

    def create_tools(self, functions: list[FunctionDefinition]) -> list[dict[str, Any]]:
        return generate_openai_tools_format(functions)
