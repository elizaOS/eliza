"""BFCL tool schema helpers.

This module provides the small adapter surface used by the BFCL runner and
the shared eliza benchmark bridge. It intentionally avoids depending on an
elizaOS runtime so mock and smoke-test paths can import cleanly.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from benchmarks.bfcl.types import FunctionCall, FunctionDefinition


def _json_schema_for_function(function: FunctionDefinition) -> dict[str, Any]:
    properties: dict[str, Any] = {}
    for name, parameter in function.parameters.items():
        schema: dict[str, Any] = {
            "type": parameter.param_type or "string",
            "description": parameter.description,
        }
        if parameter.enum is not None:
            schema["enum"] = parameter.enum
        if parameter.default is not None:
            schema["default"] = parameter.default
        if parameter.items is not None:
            schema["items"] = parameter.items
        if parameter.properties is not None:
            schema["properties"] = parameter.properties
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
