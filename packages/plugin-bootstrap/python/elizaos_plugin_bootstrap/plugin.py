"""
elizaOS Bootstrap Plugin - Python implementation.

This module defines the main plugin that provides core bootstrap
functionality for elizaOS agents.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.types import Plugin

from .actions import ALL_ACTIONS
from .evaluators import ALL_EVALUATORS
from .providers import ALL_PROVIDERS
from .services import ALL_SERVICES

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime


async def init_bootstrap_plugin(
    config: dict[str, str | int | float | bool | None],
    runtime: IAgentRuntime,
) -> None:
    """
    Initialize the Bootstrap plugin.

    This function is called when the plugin is loaded and registered
    with the agent runtime.

    Args:
        config: Plugin configuration options
        runtime: The agent runtime instance
    """
    runtime.logger.info(
        {"src": "plugin:bootstrap", "agentId": runtime.agent_id},
        "Initializing Bootstrap plugin",
    )

    # Initialize services
    for service_class in ALL_SERVICES:
        service = service_class()
        await service.start(runtime)
        runtime.register_service(service)

    runtime.logger.info(
        {
            "src": "plugin:bootstrap",
            "agentId": runtime.agent_id,
            "actionCount": len(ALL_ACTIONS),
            "providerCount": len(ALL_PROVIDERS),
            "evaluatorCount": len(ALL_EVALUATORS),
            "serviceCount": len(ALL_SERVICES),
        },
        "Bootstrap plugin initialized",
    )


# Create the plugin instance
bootstrap_plugin = Plugin(
    name="@elizaos/plugin-bootstrap",
    description=(
        "elizaOS Bootstrap Plugin - Python implementation of core agent "
        "actions, providers, evaluators, and services"
    ),
    init=init_bootstrap_plugin,
    config={},
    actions=ALL_ACTIONS,
    providers=ALL_PROVIDERS,
    evaluators=ALL_EVALUATORS,
)

# Export the plugin as the default
__all__ = ["bootstrap_plugin"]
