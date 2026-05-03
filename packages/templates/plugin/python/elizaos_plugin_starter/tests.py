"""
E2E (End-to-End) Test Suite for elizaOS Python Plugin Starter
==============================================================

This file contains end-to-end tests that run within a real elizaOS runtime environment.
Unlike unit tests that test individual components in isolation, e2e tests validate
the entire plugin behavior in a production-like environment.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.types.plugin import TestCase, TestSuite

# Import IAgentRuntime to resolve forward references
from elizaos.types.runtime import IAgentRuntime

# Rebuild Pydantic models to resolve forward references
TestCase.model_rebuild()
TestSuite.model_rebuild()

if TYPE_CHECKING:
    pass  # Already imported above


def create_test_suite() -> TestSuite:
    """Create the E2E test suite for the Python plugin starter."""

    async def example_test(runtime: IAgentRuntime) -> None:
        """
        Basic Plugin Verification Test
        -----------------------------
        This test verifies that the plugin is properly loaded and initialized
        within the runtime environment.
        """
        # Verify the plugin is loaded properly
        service = runtime.get_service("python-starter")
        if not service:
            raise RuntimeError("Python starter service not found")

    async def should_have_hello_python_action(runtime: IAgentRuntime) -> None:
        """
        Action Registration Test
        ------------------------
        Verifies that custom actions are properly registered with the runtime.
        This is important to ensure actions are available for the agent to use.
        """
        # Access actions through runtime.actions
        runtime_actions = runtime.actions
        if not runtime_actions:
            raise RuntimeError("Runtime actions not found")

        action_exists = any(
            action.name == "HELLO_PYTHON" for action in runtime_actions
        )
        if not action_exists:
            raise RuntimeError(
                "HELLO_PYTHON action not found in runtime actions"
            )

    async def hello_python_action_test(runtime: IAgentRuntime) -> None:
        """
        Hello Python Action Response Test
        ---------------------------------
        This test demonstrates a complete scenario where:
        1. The agent is asked to say hello
        2. The HELLO_PYTHON action is triggered
        3. The agent responds with text containing "Hello from Python"

        This is a key pattern for testing agent behaviors - you simulate
        a user message and verify the agent's response.
        """
        from elizaos.types.memory import Memory
        from elizaos.types.state import State

        # Create a test message asking the agent to say hello
        test_message = Memory(
            entity_id="12345678-1234-1234-1234-123456789012",
            room_id="12345678-1234-1234-1234-123456789012",
            content={
                "text": "Can you say hello?",
                "source": "test",
                "actions": ["HELLO_PYTHON"],  # Specify which action we expect
            },
        )

        # Create a test state (can include context if needed)
        test_state = State(
            values={},
            data={},
            text="",
        )

        response_received = False
        response_text = ""

        # Find the hello python action in runtime.actions
        runtime_actions = runtime.actions
        if not runtime_actions:
            raise RuntimeError("Runtime actions not found")

        hello_python_action = next(
            (a for a in runtime_actions if a.name == "HELLO_PYTHON"), None
        )
        if not hello_python_action:
            raise RuntimeError(
                "HELLO_PYTHON action not found in runtime actions"
            )

        # Create a callback that captures the agent's response
        # This simulates how the runtime would handle the action's response
        from elizaos.types.primitives import Content

        async def callback(response: Content) -> list:
            nonlocal response_received, response_text
            response_received = True
            response_text = response.text or ""

            # Verify the response includes the expected action
            response_actions = response.actions or []
            if "HELLO_PYTHON" not in response_actions:
                raise RuntimeError(
                    "Response did not include HELLO_PYTHON action"
                )

            # Return empty list as required by the HandlerCallback interface
            return []

        # Execute the action - this simulates the runtime calling the action
        if not hello_python_action.handler:
            raise RuntimeError("HELLO_PYTHON action handler not found")

        result = await hello_python_action.handler(
            runtime,
            test_message,
            test_state,
            {},
            callback,
            None,
        )

        # Verify we received a response
        if not response_received:
            raise RuntimeError(
                "HELLO_PYTHON action did not produce a response"
            )

        # Verify the response contains "Hello from Python" (case-insensitive)
        if "hello from python" not in response_text.lower():
            raise RuntimeError(
                f'Expected response to contain "Hello from Python" but got: "{response_text}"'
            )

        # Verify the action result is successful
        if not result or not result.success:
            raise RuntimeError(
                f"Action result was not successful: {result.error if result else 'No result'}"
            )

        # Success! The agent responded with "Hello from Python" as expected

    async def hello_python_provider_test(runtime: IAgentRuntime) -> None:
        """
        Provider Functionality Test
        ---------------------------
        Tests that providers can supply data to the agent when needed.
        Providers are used to fetch external data or compute values.
        """
        from elizaos.types.memory import Memory
        from elizaos.types.state import State

        # Create a test message
        test_message = Memory(
            entity_id="12345678-1234-1234-1234-123456789012",
            room_id="12345678-1234-1234-1234-123456789012",
            content={
                "text": "What can you provide?",
                "source": "test",
            },
        )

        # Create a test state
        test_state = State(
            values={},
            data={},
            text="",
        )

        # Find the python info provider in runtime.providers
        runtime_providers = runtime.providers
        if not runtime_providers:
            raise RuntimeError("Runtime providers not found")

        python_info_provider = next(
            (p for p in runtime_providers if p.name == "PYTHON_INFO"), None
        )
        if not python_info_provider:
            raise RuntimeError(
                "PYTHON_INFO provider not found in runtime providers"
            )

        # Test the provider
        if not python_info_provider.get:
            raise RuntimeError("PYTHON_INFO provider get function not found")

        result = await python_info_provider.get(
            runtime, test_message, test_state
        )

        if not result.text or "Python" not in result.text:
            raise RuntimeError(
                f'Expected provider to return text containing "Python", got "{result.text}"'
            )

        if not result.values or result.values.get("language") != "python":
            raise RuntimeError(
                f'Expected provider values to contain language="python", got {result.values}'
            )

    async def starter_service_test(runtime: IAgentRuntime) -> None:
        """
        Service Lifecycle Test
        ----------------------
        Verifies that services can be started, accessed, and stopped properly.
        Services run background tasks or manage long-lived resources.
        """
        # Get the service from the runtime
        service = runtime.get_service("python-starter")
        if not service:
            raise RuntimeError("Python starter service not found")

        # Check service capability description
        if not hasattr(service, "capability_description"):
            raise RuntimeError("Service does not have capability_description")

        capability_desc = service.capability_description
        if not capability_desc or "Python Starter Service" not in capability_desc:
            raise RuntimeError(
                f"Incorrect service capability description: {capability_desc}"
            )

        # Test service increment_requests method if available
        if hasattr(service, "increment_requests"):
            initial_count = getattr(service, "request_count", 0)
            new_count = service.increment_requests()
            if new_count != initial_count + 1:
                raise RuntimeError(
                    f"Service increment_requests did not work correctly. Expected {initial_count + 1}, got {new_count}"
                )

        # Test service stop method
        await service.stop()

    return TestSuite(
        name="python_plugin_starter_test_suite",
        tests=[
            TestCase(name="example_test", fn=example_test),
            TestCase(
                name="should_have_hello_python_action",
                fn=should_have_hello_python_action,
            ),
            TestCase(
                name="hello_python_action_test", fn=hello_python_action_test
            ),
            TestCase(
                name="hello_python_provider_test",
                fn=hello_python_provider_test,
            ),
            TestCase(name="starter_service_test", fn=starter_service_test),
        ],
    )


# Export the test suite
python_plugin_starter_test_suite = create_test_suite()

