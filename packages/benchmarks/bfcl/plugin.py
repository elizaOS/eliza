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
    for key, value in schema.items():
        if key == "type":
            if isinstance(value, str):
                type_name = value.lower()
                if type_name in _UNCONSTRAINED_SCHEMA_TYPES:
                    continue
                normalized[key] = _JSON_SCHEMA_TYPE_ALIASES.get(type_name, "string")
            elif isinstance(value, list):
                normalized_types = [
                    _JSON_SCHEMA_TYPE_ALIASES.get(str(item).lower(), "string")
                    for item in value
                    if str(item).lower() not in _UNCONSTRAINED_SCHEMA_TYPES
                ]
                if normalized_types:
                    normalized[key] = normalized_types
            else:
                normalized[key] = value
        elif key in {"items", "properties", "additionalProperties"}:
            normalized[key] = _normalize_schema(value)
        else:
            normalized[key] = _normalize_schema(value)
    return normalized


def _json_schema_for_function(function: FunctionDefinition) -> dict[str, Any]:
    properties: dict[str, Any] = {}
    for name, parameter in function.parameters.items():
        schema: dict[str, Any] = {
            "description": parameter.description,
        }
        param_type = (parameter.param_type or "string").lower()
        if param_type not in _UNCONSTRAINED_SCHEMA_TYPES:
            schema["type"] = _JSON_SCHEMA_TYPE_ALIASES.get(param_type, "string")
        if parameter.enum is not None:
            schema["enum"] = parameter.enum
        if parameter.default is not None:
            schema["default"] = parameter.default
        if parameter.items is not None:
            schema["items"] = _normalize_schema(parameter.items)
        if parameter.properties is not None:
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
