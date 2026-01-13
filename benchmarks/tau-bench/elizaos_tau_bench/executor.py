"""
Tool executor for Tau-bench.
"""

from typing import Optional

from elizaos_tau_bench.types import ToolCall, ToolDefinition, ToolCallStatus
from elizaos_tau_bench.environments.base import DomainEnvironment


class ToolExecutor:
    """Executes tool calls against a domain environment."""

    def __init__(self, environment: DomainEnvironment) -> None:
        self.environment = environment
        self.available_tools: dict[str, ToolDefinition] = {}

    def register_tools(self, tools: list[ToolDefinition]) -> None:
        """Register available tools."""
        for tool in tools:
            self.available_tools[tool.name] = tool

    async def execute(self, tool_call: ToolCall) -> ToolCall:
        """Execute a tool call and return with result."""
        if tool_call.tool_name not in self.available_tools:
            tool_call.status = ToolCallStatus.WRONG_TOOL
            tool_call.result = {"error": f"Tool '{tool_call.tool_name}' not available"}
            tool_call.error_message = f"Unknown tool: {tool_call.tool_name}"
            return tool_call

        tool_def = self.available_tools[tool_call.tool_name]

        # Validate parameters
        validation_error = self._validate_parameters(tool_def, tool_call.arguments)
        if validation_error:
            tool_call.status = ToolCallStatus.WRONG_PARAMS
            tool_call.result = {"error": validation_error}
            tool_call.error_message = validation_error
            return tool_call

        # Execute through environment
        import time
        start_time = time.time()
        try:
            tool_call.result = await self.environment.execute_tool(tool_call)
            tool_call.execution_time_ms = (time.time() - start_time) * 1000
        except Exception as e:
            tool_call.status = ToolCallStatus.EXECUTION_ERROR
            tool_call.result = {"error": str(e)}
            tool_call.error_message = str(e)
            tool_call.execution_time_ms = (time.time() - start_time) * 1000

        return tool_call

    def _validate_parameters(
        self, tool_def: ToolDefinition, args: dict[str, object]
    ) -> Optional[str]:
        """Validate tool call parameters against schema."""
        params_schema = tool_def.parameters
        required: list[str] = params_schema.get("required", [])
        properties: dict[str, dict[str, str]] = params_schema.get("properties", {})

        # Check required parameters
        for param in required:
            if param not in args:
                return f"Missing required parameter: {param}"

        # Type validation (basic)
        for param, value in args.items():
            if param in properties:
                expected_type = properties[param].get("type")
                if expected_type:
                    if expected_type == "string" and not isinstance(value, str):
                        return f"Parameter '{param}' must be a string"
                    elif expected_type == "integer" and not isinstance(value, int):
                        return f"Parameter '{param}' must be an integer"
                    elif expected_type == "number" and not isinstance(value, (int, float)):
                        return f"Parameter '{param}' must be a number"
                    elif expected_type == "boolean" and not isinstance(value, bool):
                        return f"Parameter '{param}' must be a boolean"
                    elif expected_type == "array" and not isinstance(value, list):
                        return f"Parameter '{param}' must be an array"
                    elif expected_type == "object" and not isinstance(value, dict):
                        return f"Parameter '{param}' must be an object"

        return None

    def get_tools_description(self) -> str:
        """Get a formatted description of all available tools."""
        import json
        lines = []
        for tool in self.available_tools.values():
            lines.append(f"- {tool.name}: {tool.description}")
            lines.append(f"  Parameters: {json.dumps(tool.parameters, indent=2)}")
        return "\n".join(lines)
