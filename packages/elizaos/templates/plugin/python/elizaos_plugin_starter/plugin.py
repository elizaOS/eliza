"""
elizaOS Python Plugin Starter Implementation

This module provides a template for creating elizaOS plugins in Python.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from elizaos.types.plugin import Plugin
from elizaos.types.components import (
    Action,
    ActionResult,
    Provider,
    ProviderResult,
    HandlerOptions,
)
from elizaos.types.memory import Memory
from elizaos.types.state import State
from elizaos.types.service import Service
from elizaos.logger import create_logger

if TYPE_CHECKING:
    from elizaos.types.runtime import IAgentRuntime

# Import test suite for E2E tests
from elizaos_plugin_starter.tests import python_plugin_starter_test_suite

logger = create_logger(namespace="python-plugin-starter")


# =============================================================================
# Actions
# =============================================================================


async def hello_python_validate(
    runtime: "IAgentRuntime",
    message: Memory,
    state: State | None,
) -> bool:
    """Validate the HELLO_PYTHON action."""
    # Always valid - you can add your validation logic here
    return True


async def hello_python_handler(
    runtime: "IAgentRuntime",
    message: Memory,
    state: State | None,
    options: HandlerOptions | None,
    callback: Any | None,
    responses: list[Memory] | None,
) -> ActionResult | None:
    """Handle the HELLO_PYTHON action."""
    # Get the user's message
    user_text = message.content.text if message.content else "friend"

    response_text = f"Hello from Python, {user_text}! 🐍"

    # Optionally call the callback to stream the response
    if callback:
        await callback(
            {
                "text": response_text,
                "actions": ["HELLO_PYTHON"],
                "source": message.content.source if message.content else None,
            }
        )

    return ActionResult(
        success=True,
        text=response_text,
        data={
            "language": "python",
            "greeting": response_text,
        },
    )


hello_python_action = Action(
    name="HELLO_PYTHON",
    description="Says hello from Python - demonstrates a basic Python action",
    similes=["GREET_PYTHON", "PYTHON_HELLO", "SAY_HI_PYTHON"],
    examples=[
        [
            {"name": "{{userName}}", "content": {"text": "hello", "actions": []}},
            {
                "name": "{{agentName}}",
                "content": {"text": "Hello from Python! 🐍", "actions": ["HELLO_PYTHON"]},
            },
        ]
    ],
    validate=hello_python_validate,
    handler=hello_python_handler,
)


# =============================================================================
# Providers
# =============================================================================


async def python_info_get(
    runtime: "IAgentRuntime",
    message: Memory,
    state: State,
) -> ProviderResult:
    """Get Python plugin information."""
    import sys
    import platform

    return ProviderResult(
        text="This is a Python plugin running via the elizaOS runtime!",
        values={
            "language": "python",
            "version": sys.version,
            "platform": platform.platform(),
        },
        data={
            "runtime_info": {
                "python_version": sys.version_info[:3],
                "implementation": platform.python_implementation(),
            }
        },
    )


python_info_provider = Provider(
    name="PYTHON_INFO",
    description="Provides information about the Python plugin and environment",
    dynamic=True,
    get=python_info_get,
)


# =============================================================================
# Services
# =============================================================================


class StarterService(Service):
    """
    Example service that demonstrates service lifecycle.

    Services are long-running components that can maintain state
    and provide functionality to actions and providers.
    """

    service_type = "python-starter"

    def __init__(self, runtime: "IAgentRuntime") -> None:
        super().__init__(runtime)
        self.initialized = False
        self.request_count = 0

    @classmethod
    async def start(cls, runtime: "IAgentRuntime") -> "StarterService":
        """Start the service."""
        logger.info("Starting Python Starter Service")
        service = cls(runtime)
        service.initialized = True
        return service

    async def stop(self) -> None:
        """Instance stop method."""
        logger.info("Python Starter Service stopped")
        self.initialized = False

    def increment_requests(self) -> int:
        """Increment and return the request count."""
        self.request_count += 1
        return self.request_count

    @property
    def capability_description(self) -> str:
        """Describe what this service provides."""
        return "Python Starter Service - demonstrates service lifecycle and state management"


# =============================================================================
# Plugin Initialization
# =============================================================================


async def plugin_init(
    config: dict[str, str],
    runtime: "IAgentRuntime",
) -> None:
    """
    Initialize the plugin with configuration.

    This is called when the plugin is registered with the runtime.
    You can use this to set up resources, validate configuration, etc.
    """
    logger.info("Initializing Python Starter Plugin")

    # Example: validate configuration
    example_var = config.get("EXAMPLE_PLUGIN_VARIABLE")
    if example_var:
        logger.debug(f"Example variable set to: {example_var}")
    else:
        logger.debug("Example variable not set (this is expected)")

    logger.info("Python Starter Plugin initialized successfully")


# =============================================================================
# Plugin Definition
# =============================================================================


plugin = Plugin(
    name="python-plugin-starter",
    description="Starter template for elizaOS Python plugins",
    # Initialization function
    init=plugin_init,
    # Configuration (loaded from environment)
    config={
        "EXAMPLE_PLUGIN_VARIABLE": None,  # Optional configuration
    },
    # Actions the plugin provides
    actions=[
        hello_python_action,
    ],
    # Providers for context
    providers=[
        python_info_provider,
    ],
    # Services
    services=[
        StarterService,
    ],
    # Test suites for E2E testing
    tests=[
        python_plugin_starter_test_suite,
    ],
    # Plugin dependencies (if any)
    # dependencies=["@elizaos/plugin-sql"],
)
