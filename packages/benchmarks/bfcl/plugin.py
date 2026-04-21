"""
BFCL Plugin Factory

Creates dynamic ElizaOS plugins from BFCL test case function definitions.
"""

from __future__ import annotations

import logging
from typing import Optional

from benchmarks.bfcl.types import (
    ArgumentValue,
    BFCLTestCase,
    FunctionCall,
    FunctionDefinition,
    FunctionParameter,
)

logger = logging.getLogger(__name__)


# Import ElizaOS types
try:
    from elizaos.types.components import (
        Action,
        ActionParameter,
        ActionParameterSchema,
        ActionResult,
        HandlerOptions,
    )
    from elizaos.types.memory import Memory
    from elizaos.types.plugin import Plugin
    from elizaos.types.runtime import IAgentRuntime
    from elizaos.types.state import State

    ELIZAOS_AVAILABLE = True
except ImportError:
    ELIZAOS_AVAILABLE = False
    logger.warning("ElizaOS not available, plugin creation will be limited")


class FunctionCallCapture:
    """Captures function calls made during test execution."""

    def __init__(self) -> None:
        self._calls: list[FunctionCall] = []

    def capture(self, name: str, arguments: dict[str, object]) -> None:
        """Record a function call."""
        # Normalize arguments to ArgumentValue type
        normalized_args = self._normalize_arguments(arguments)
        self._calls.append(FunctionCall(name=name, arguments=normalized_args))

    def _normalize_arguments(self, args: dict[str, object]) -> dict[str, ArgumentValue]:
        """Normalize argument values to proper types."""
        normalized: dict[str, ArgumentValue] = {}
        for key, value in args.items():
            normalized[str(key)] = self._normalize_value(value)
        return normalized

    def _normalize_value(self, value: object) -> ArgumentValue:
        """Normalize a single value to ArgumentValue type."""
        if value is None:
            return None
        if isinstance(value, (str, int, float, bool)):
            return value
        if isinstance(value, list):
            return [self._normalize_value(v) for v in value]
        if isinstance(value, dict):
            return {str(k): self._normalize_value(v) for k, v in value.items()}
        return str(value)

    def get_calls(self) -> list[FunctionCall]:
        """Get all captured calls."""
        return self._calls.copy()

    def clear(self) -> None:
        """Clear captured calls."""
        self._calls.clear()


# Global capture instance
_call_capture = FunctionCallCapture()


def get_call_capture() -> FunctionCallCapture:
    """Get the global call capture instance."""
    return _call_capture


def _convert_type_to_schema(param_type: str) -> str:
    """Convert BFCL type to JSON Schema type."""
    type_mapping = {
        "string": "string",
        "str": "string",
        "integer": "number",
        "int": "number",
        "number": "number",
        "float": "number",
        "boolean": "boolean",
        "bool": "boolean",
        "array": "array",
        "list": "array",
        "object": "object",
        "dict": "object",
    }
    return type_mapping.get(param_type.lower(), "string")


def create_action_parameter(
    param: FunctionParameter,
) -> "ActionParameter":
    """Convert a BFCL FunctionParameter to an ElizaOS ActionParameter."""
    if not ELIZAOS_AVAILABLE:
        raise ImportError("ElizaOS is required for action parameter creation")

    schema = ActionParameterSchema(
        type=_convert_type_to_schema(param.param_type),
        description=param.description,
        enum=param.enum,
        default=param.default,
        items=param.items,
        properties=param.properties,
    )

    return ActionParameter(
        name=param.name,
        description=param.description,
        required=param.required,
        schema=schema,
    )


def create_mock_handler(func_name: str) -> "Action.handler":
    """Create a mock handler that captures function calls."""
    if not ELIZAOS_AVAILABLE:
        raise ImportError("ElizaOS is required for handler creation")

    async def handler(
        runtime: "IAgentRuntime",
        message: "Memory",
        state: Optional["State"] = None,
        options: Optional["HandlerOptions"] = None,
        callback: Optional[object] = None,
        responses: Optional[list["Memory"]] = None,
    ) -> "ActionResult":
        """Mock handler that captures calls and returns success."""
        # Extract parameters from options
        params: dict[str, object] = {}
        if options and options.parameters:
            params = dict(options.parameters)

        # Capture the call
        _call_capture.capture(func_name, params)

        logger.debug(f"Mock handler called: {func_name}({params})")

        return ActionResult(
            success=True,
            text=f"Successfully executed {func_name}",
            data={
                "function": func_name,
                "arguments": params,
                "status": "mock_success",
            },
        )

    return handler


def create_mock_validator() -> "Action.validate_fn":
    """Create a validator that always returns True."""
    if not ELIZAOS_AVAILABLE:
        raise ImportError("ElizaOS is required for validator creation")

    async def validate(
        runtime: "IAgentRuntime",
        message: "Memory",
        state: Optional["State"] = None,
    ) -> bool:
        return True

    return validate


def create_function_action(func_def: FunctionDefinition) -> "Action":
    """Convert a BFCL FunctionDefinition to an ElizaOS Action."""
    if not ELIZAOS_AVAILABLE:
        raise ImportError("ElizaOS is required for action creation")

    # Convert parameters
    parameters = [
        create_action_parameter(param)
        for param in func_def.parameters.values()
    ]

    return Action(
        name=func_def.name,
        description=func_def.description,
        parameters=parameters,
        handler=create_mock_handler(func_def.name),
        validate=create_mock_validator(),
        tags=["bfcl", "benchmark", func_def.category or "general"],
    )


class BFCLPluginFactory:
    """Factory for creating ElizaOS plugins from BFCL test cases."""

    def __init__(self) -> None:
        self._created_plugins: dict[str, "Plugin"] = {}

    def create_plugin(self, test_case: BFCLTestCase) -> "Plugin":
        """
        Create an ElizaOS plugin with test case functions.

        Args:
            test_case: The BFCL test case

        Returns:
            Plugin configured with the test case's functions
        """
        if not ELIZAOS_AVAILABLE:
            raise ImportError("ElizaOS is required for plugin creation")

        plugin_name = f"bfcl_{test_case.id}"

        # Create actions from function definitions
        actions = [
            create_function_action(func_def)
            for func_def in test_case.functions
        ]

        plugin = Plugin(
            name=plugin_name,
            description=f"BFCL test case functions: {test_case.category.value}",
            actions=actions,
        )

        self._created_plugins[plugin_name] = plugin
        return plugin

    def create_multi_test_plugin(
        self,
        test_cases: list[BFCLTestCase],
        plugin_name: str = "bfcl_benchmark",
    ) -> "Plugin":
        """
        Create a single plugin with functions from multiple test cases.

        Args:
            test_cases: List of BFCL test cases
            plugin_name: Name for the combined plugin

        Returns:
            Plugin with all unique functions from test cases
        """
        if not ELIZAOS_AVAILABLE:
            raise ImportError("ElizaOS is required for plugin creation")

        # Collect unique functions by name
        unique_functions: dict[str, FunctionDefinition] = {}
        for tc in test_cases:
            for func in tc.functions:
                if func.name not in unique_functions:
                    unique_functions[func.name] = func

        # Create actions
        actions = [
            create_function_action(func_def)
            for func_def in unique_functions.values()
        ]

        plugin = Plugin(
            name=plugin_name,
            description="BFCL benchmark functions",
            actions=actions,
        )

        self._created_plugins[plugin_name] = plugin
        return plugin

    def get_plugin(self, name: str) -> Optional["Plugin"]:
        """Get a previously created plugin by name."""
        return self._created_plugins.get(name)

    def clear_plugins(self) -> None:
        """Clear all created plugins."""
        self._created_plugins.clear()


def generate_function_schema(func_def: FunctionDefinition) -> dict[str, object]:
    """Generate JSON Schema for a function definition."""
    properties: dict[str, dict[str, object]] = {}
    required: list[str] = []

    for param_name, param in func_def.parameters.items():
        prop_schema: dict[str, object] = {
            "type": _convert_type_to_schema(param.param_type),
            "description": param.description,
        }

        if param.enum:
            prop_schema["enum"] = param.enum
        if param.default is not None:
            prop_schema["default"] = param.default
        if param.items:
            prop_schema["items"] = param.items
        if param.properties:
            prop_schema["properties"] = param.properties

        properties[param_name] = prop_schema

        if param.required:
            required.append(param_name)

    return {
        "name": func_def.name,
        "description": func_def.description,
        "parameters": {
            "type": "object",
            "properties": properties,
            "required": required,
        },
    }


def generate_openai_tools_format(
    functions: list[FunctionDefinition],
) -> list[dict[str, object]]:
    """Generate OpenAI tools format for function definitions."""
    return [
        {
            "type": "function",
            "function": generate_function_schema(func),
        }
        for func in functions
    ]
