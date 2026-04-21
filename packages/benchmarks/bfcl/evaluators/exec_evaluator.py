"""
BFCL Execution Evaluator

Evaluates function calls by actually executing them and comparing results.
Uses mock functions for safe, reproducible testing.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable, Awaitable
from typing import Optional

from benchmarks.bfcl.types import ArgumentValue, FunctionCall, FunctionDefinition

logger = logging.getLogger(__name__)


# Type for mock function handlers
MockHandler = Callable[..., Awaitable[object] | object]


class MockFunctionRegistry:
    """Registry of mock functions for execution testing."""

    def __init__(self) -> None:
        self._functions: dict[str, MockHandler] = {}
        self._results: dict[str, object] = {}  # Pre-configured results

    def register(self, name: str, handler: MockHandler) -> None:
        """Register a mock function handler."""
        self._functions[name.lower()] = handler

    def register_result(self, name: str, result: object) -> None:
        """Register a pre-configured result for a function."""
        self._results[name.lower()] = result

    def get_handler(self, name: str) -> Optional[MockHandler]:
        """Get a mock handler by function name."""
        return self._functions.get(name.lower())

    def get_result(self, name: str) -> Optional[object]:
        """Get a pre-configured result."""
        return self._results.get(name.lower())

    def has_function(self, name: str) -> bool:
        """Check if a function is registered."""
        return (
            name.lower() in self._functions or
            name.lower() in self._results
        )

    def clear(self) -> None:
        """Clear all registered functions and results."""
        self._functions.clear()
        self._results.clear()


class ExecutionEvaluator:
    """
    Evaluate function call execution.

    Executes function calls using mock handlers and compares results
    to expected outputs.
    """

    def __init__(
        self,
        timeout_ms: int = 5000,
        allow_partial_execution: bool = False,
    ):
        """
        Initialize execution evaluator.

        Args:
            timeout_ms: Timeout for each function execution in milliseconds
            allow_partial_execution: If True, partial success counts
        """
        self.timeout_ms = timeout_ms
        self.allow_partial_execution = allow_partial_execution
        self.registry = MockFunctionRegistry()

    def register_mock(self, name: str, handler: MockHandler) -> None:
        """Register a mock function for execution testing."""
        self.registry.register(name, handler)

    def register_mocks_from_definitions(
        self,
        definitions: list[FunctionDefinition],
    ) -> None:
        """
        Auto-generate mock functions from definitions.

        Creates simple mock handlers that return success responses.
        """
        for func_def in definitions:
            # Create a simple mock that returns a success indicator
            async def mock_handler(
                func_name: str = func_def.name,
                **kwargs: object,
            ) -> dict[str, object]:
                return {
                    "status": "success",
                    "function": func_name,
                    "arguments": kwargs,
                }

            self.registry.register(func_def.name, mock_handler)

    async def execute(
        self,
        call: FunctionCall,
    ) -> tuple[bool, object, Optional[str]]:
        """
        Execute a single function call.

        Args:
            call: The function call to execute

        Returns:
            Tuple of (success, result, error_message)
        """
        handler = self.registry.get_handler(call.name)

        # Check for pre-configured result first
        preconfigured = self.registry.get_result(call.name)
        if preconfigured is not None:
            return True, preconfigured, None

        if handler is None:
            return False, None, f"No mock handler for function: {call.name}"

        try:
            # Execute with timeout
            timeout_seconds = self.timeout_ms / 1000

            # Convert arguments to proper types for the handler
            safe_args = self._prepare_arguments_for_execution(call.arguments)

            result = handler(**safe_args)
            if asyncio.iscoroutine(result):
                result = await asyncio.wait_for(result, timeout=timeout_seconds)

            return True, result, None

        except asyncio.TimeoutError:
            return False, None, f"Execution timeout for {call.name}"
        except TypeError as e:
            return False, None, f"Argument error for {call.name}: {e}"
        except Exception as e:
            return False, None, f"Execution error for {call.name}: {e}"

    def _prepare_arguments_for_execution(
        self,
        arguments: dict[str, ArgumentValue],
    ) -> dict[str, str | int | float | bool | list[object] | dict[str, object]]:
        """Prepare arguments for safe execution by handlers."""
        prepared: dict[str, str | int | float | bool | list[object] | dict[str, object]] = {}
        for key, value in arguments.items():
            prepared[key] = self._convert_argument_value(value)
        return prepared

    def _convert_argument_value(
        self,
        value: ArgumentValue,
    ) -> str | int | float | bool | list[object] | dict[str, object]:
        """Convert an ArgumentValue to a handler-safe value."""
        if value is None:
            return ""  # Convert None to empty string for handler compatibility
        if isinstance(value, (str, int, float, bool)):
            return value
        if isinstance(value, list):
            return [self._convert_argument_value(v) for v in value]
        if isinstance(value, dict):
            return {k: self._convert_argument_value(v) for k, v in value.items()}
        return str(value)

    async def execute_all(
        self,
        calls: list[FunctionCall],
    ) -> tuple[bool, list[object], list[str]]:
        """
        Execute all function calls.

        Args:
            calls: List of function calls to execute

        Returns:
            Tuple of (all_success, results, errors)
        """
        results: list[object] = []
        errors: list[str] = []
        all_success = True

        for call in calls:
            success, result, error = await self.execute(call)
            results.append(result)
            if error:
                errors.append(error)
            if not success:
                all_success = False
                if not self.allow_partial_execution:
                    break

        return all_success, results, errors

    async def verify_output(
        self,
        predicted_calls: list[FunctionCall],
        expected_output: Optional[str],
    ) -> bool:
        """
        Verify that executing predicted calls produces expected output.

        Args:
            predicted_calls: Calls to execute
            expected_output: Expected output to compare against

        Returns:
            True if output matches, False otherwise
        """
        if expected_output is None:
            # No expected output, just check execution success
            success, _, _ = await self.execute_all(predicted_calls)
            return success

        success, results, _ = await self.execute_all(predicted_calls)
        if not success:
            return False

        # Compare final result to expected output
        if results:
            final_result = str(results[-1])
            return self._output_matches(final_result, expected_output)

        return False

    def _output_matches(
        self,
        actual: str,
        expected: str,
    ) -> bool:
        """Check if actual output matches expected output."""
        # Normalize and compare
        actual_normalized = actual.strip().lower()
        expected_normalized = expected.strip().lower()

        return actual_normalized == expected_normalized

    def setup_standard_mocks(self) -> None:
        """Set up standard mock functions for common BFCL test cases."""
        # Weather API mock
        async def get_weather(location: str, unit: str = "celsius") -> dict[str, object]:
            return {
                "location": location,
                "temperature": 22 if unit == "celsius" else 72,
                "unit": unit,
                "conditions": "sunny",
            }

        # Search mock
        async def search(query: str, num_results: int = 10) -> dict[str, object]:
            return {
                "query": query,
                "results": [
                    {"title": f"Result {i}", "url": f"https://example.com/{i}"}
                    for i in range(num_results)
                ],
            }

        # Calculator mock
        async def calculate(expression: str) -> dict[str, object]:
            # Simple eval for basic math (in production, use a safe parser)
            try:
                result = eval(expression, {"__builtins__": {}})  # noqa: S307
                return {"expression": expression, "result": result}
            except Exception:
                return {"expression": expression, "error": "Invalid expression"}

        # Calendar mock
        async def create_event(
            title: str,
            start_time: str,
            end_time: str = "",
            location: str = "",
        ) -> dict[str, object]:
            return {
                "event_id": "evt_123",
                "title": title,
                "start_time": start_time,
                "end_time": end_time,
                "location": location,
                "status": "created",
            }

        # Email mock
        async def send_email(
            to: str,
            subject: str,
            body: str,
        ) -> dict[str, object]:
            return {
                "message_id": "msg_456",
                "to": to,
                "subject": subject,
                "status": "sent",
            }

        # Register standard mocks
        self.registry.register("get_weather", get_weather)
        self.registry.register("search", search)
        self.registry.register("calculate", calculate)
        self.registry.register("create_event", create_event)
        self.registry.register("send_email", send_email)
