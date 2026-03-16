"""elizaOS Bootstrap Plugin - Python implementation."""

from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.action_docs import with_canonical_action_docs, with_canonical_evaluator_docs
from elizaos.advanced_capabilities import (
    advanced_actions,
    advanced_evaluators,
    advanced_providers,
    advanced_services,
)

# Import from new capability modules
from elizaos.basic_capabilities import basic_actions, basic_providers, basic_services
from elizaos.types import Plugin

# Autonomy capabilities remain in bootstrap
from .autonomy import (
    AutonomyService,
    admin_chat_provider,
    autonomy_status_provider,
    send_to_admin_action,
)
from .types import CapabilityConfig

# Re-export for backward compatibility
BASIC_ACTIONS = basic_actions
EXTENDED_ACTIONS = advanced_actions
BASIC_PROVIDERS = basic_providers
EXTENDED_PROVIDERS = advanced_providers
BASIC_EVALUATORS: list = []  # No basic evaluators
EXTENDED_EVALUATORS = advanced_evaluators
BASIC_SERVICES = basic_services
EXTENDED_SERVICES = advanced_services

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime


def _get_providers(config: CapabilityConfig) -> list:
    """Get providers based on capability config."""
    result = []
    if not config.disable_basic:
        providers_to_add = BASIC_PROVIDERS
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
    return result


def _get_services(config: CapabilityConfig) -> list[type]:
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
    """Create a bootstrap plugin with the specified capability configuration."""
    if config is None:
        config = CapabilityConfig()

    providers = _get_providers(config)
    actions = [with_canonical_action_docs(a) for a in _get_actions(config)]
    evaluators = [with_canonical_evaluator_docs(e) for e in _get_evaluators(config)]
    services = _get_services(config)

    async def init_plugin(
        plugin_config: dict[str, str | int | float | bool | None],
        runtime: IAgentRuntime,
    ) -> None:
        """Initialize the Bootstrap plugin."""
        _ = plugin_config
        runtime.logger.info(
            "Initializing Bootstrap plugin",
            src="plugin:bootstrap",
            agentId=str(runtime.agent_id),
        )

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
        services=services,
        actions=actions,
        providers=providers,
        evaluators=evaluators,
    )


bootstrap_plugin = create_bootstrap_plugin()

__all__ = ["bootstrap_plugin", "create_bootstrap_plugin", "CapabilityConfig"]
