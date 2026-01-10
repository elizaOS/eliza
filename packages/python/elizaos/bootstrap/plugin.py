"""
elizaOS Bootstrap Plugin - Python implementation.

This module defines the main plugin that provides core bootstrap
functionality for elizaOS agents.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.types import Plugin

from .actions import BASIC_ACTIONS, EXTENDED_ACTIONS
from .evaluators import BASIC_EVALUATORS, EXTENDED_EVALUATORS
from .providers import BASIC_PROVIDERS, EXTENDED_PROVIDERS
from .services import BASIC_SERVICES, EXTENDED_SERVICES
from .types import CapabilityConfig
from .autonomy import (
    AutonomyService,
    send_to_admin_action,
    admin_chat_provider,
    autonomy_status_provider,
)

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime


def _get_providers(config: CapabilityConfig) -> list:
    """Get providers based on capability config."""
    result = []
    if not config.disable_basic:
        providers_to_add = BASIC_PROVIDERS
        # Filter out character provider if skip_character_provider is set
        if config.skip_character_provider:
            providers_to_add = [p for p in providers_to_add if p.name != "CHARACTER"]
        result.extend(providers_to_add)
    if config.enable_extended:
        result.extend(EXTENDED_PROVIDERS)
    if config.enable_autonomy:
        result.extend([admin_chat_provider, autonomy_status_provider])
    return result


def _get_actions(config: CapabilityConfig) -> list:
    """Get actions based on capability config."""
    result = []
    if not config.disable_basic:
        result.extend(BASIC_ACTIONS)
    if config.enable_extended:
        result.extend(EXTENDED_ACTIONS)
    if config.enable_autonomy:
        result.append(send_to_admin_action)
    return result


def _get_evaluators(config: CapabilityConfig) -> list:
    """Get evaluators based on capability config."""
    result = []
    if not config.disable_basic:
        result.extend(BASIC_EVALUATORS)
    if config.enable_extended:
        result.extend(EXTENDED_EVALUATORS)
    # Autonomy has no evaluators currently
    return result


def _get_services(config: CapabilityConfig) -> list:
    """Get services based on capability config."""
    result = []
    if not config.disable_basic:
        result.extend(BASIC_SERVICES)
    if config.enable_extended:
        result.extend(EXTENDED_SERVICES)
    if config.enable_autonomy:
        result.append(AutonomyService)
    return result


def create_bootstrap_plugin(config: CapabilityConfig | None = None) -> Plugin:
    """
    Create a bootstrap plugin with the specified capability configuration.

    Args:
        config: Capability configuration. If None, uses default (basic only).

    Returns:
        A configured bootstrap plugin.

    Example:
        ```python
        # Create plugin with default configuration (basic capabilities enabled)
        plugin = create_bootstrap_plugin()

        # Create plugin with extended capabilities
        plugin = create_bootstrap_plugin(CapabilityConfig(enable_extended=True))

        # Create minimal plugin (no basic capabilities)
        plugin = create_bootstrap_plugin(CapabilityConfig(disable_basic=True))
        ```
    """
    if config is None:
        config = CapabilityConfig()

    providers = _get_providers(config)
    actions = _get_actions(config)
    evaluators = _get_evaluators(config)
    services = _get_services(config)

    async def init_plugin(
        plugin_config: dict[str, str | int | float | bool | None],
        runtime: IAgentRuntime,
    ) -> None:
        """Initialize the Bootstrap plugin."""
        runtime.logger.info(
            "Initializing Bootstrap plugin",
            src="plugin:bootstrap",
            agentId=str(runtime.agent_id),
        )

        # Initialize services
        for service_class in services:
            service = service_class()
            await service.start(runtime)
            await runtime.register_service(service)

        runtime.logger.info(
            "Bootstrap plugin initialized",
            src="plugin:bootstrap",
            agentId=str(runtime.agent_id),
            actionCount=len(actions),
            providerCount=len(providers),
            evaluatorCount=len(evaluators),
            serviceCount=len(services),
        )

    return Plugin(
        name="bootstrap",
        description=(
            "elizaOS Bootstrap Plugin - Python implementation of core agent "
            "actions, providers, evaluators, and services"
        ),
        init=init_plugin,
        config={},
        actions=actions,
        providers=providers,
        evaluators=evaluators,
    )


# Default bootstrap plugin (basic capabilities only)
bootstrap_plugin = create_bootstrap_plugin()

# Export the plugin and factory
__all__ = ["bootstrap_plugin", "create_bootstrap_plugin", "CapabilityConfig"]
