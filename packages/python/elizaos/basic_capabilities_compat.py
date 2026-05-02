"""elizaOS BasicCapabilities Plugin - Compatibility shim.

The basic_capabilities module was refactored into elizaos.features.basic_capabilities and
elizaos.features.advanced_capabilities.  This shim re-exports the public API so that
existing code that imports from ``elizaos.features.basic_capabilities`` continues to work.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from elizaos.action_docs import with_canonical_action_docs, with_canonical_evaluator_docs
from elizaos.features.advanced_capabilities import (
    advanced_actions,
    advanced_evaluators,
    advanced_providers,
    advanced_services,
)
from elizaos.features.basic_capabilities import basic_actions, basic_providers, basic_services
from elizaos.types import (
    EvaluatorResult,  # noqa: F401 - re-exported for backwards compat
    Plugin,
)

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime


# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------


@dataclass
class CapabilityConfig:
    """Configuration for basic_capabilities capabilities."""

    disable_basic: bool = False
    enable_extended: bool = False
    advanced_capabilities: bool = False  # Alias for enable_extended
    skip_character_provider: bool = False
    enable_autonomy: bool = False
    enable_trust: bool = False
    enable_secrets_manager: bool = False
    enable_plugin_manager: bool = False

    def __post_init__(self) -> None:
        if self.advanced_capabilities and not self.enable_extended:
            self.enable_extended = True


# ---------------------------------------------------------------------------
# Plugin factory
# ---------------------------------------------------------------------------

BASIC_ACTIONS = basic_actions
NATIVE_RELATIONSHIPS_ACTION_NAMES = {
    "ADD_CONTACT",
    "REMOVE_CONTACT",
    "SCHEDULE_FOLLOW_UP",
    "SEARCH_CONTACTS",
    "SEND_MESSAGE",
    "UPDATE_CONTACT",
    "UPDATE_ENTITY",
}
EXTENDED_ACTIONS = [
    action for action in advanced_actions if action.name not in NATIVE_RELATIONSHIPS_ACTION_NAMES
]
BASIC_PROVIDERS = basic_providers
NATIVE_FEATURE_PROVIDER_NAMES = {
    "CONTACTS",
    "FACTS",
    "FOLLOW_UPS",
    "KNOWLEDGE",
    "RELATIONSHIPS",
}
EXTENDED_PROVIDERS = [
    provider
    for provider in advanced_providers
    if provider.name not in NATIVE_FEATURE_PROVIDER_NAMES
]
BASIC_EVALUATORS: list = []
NATIVE_RELATIONSHIPS_EVALUATOR_NAMES = {
    "REFLECTION",
    "RELATIONSHIP_EXTRACTION",
}
EXTENDED_EVALUATORS = [
    evaluator
    for evaluator in advanced_evaluators
    if evaluator.name not in NATIVE_RELATIONSHIPS_EVALUATOR_NAMES
]
BASIC_SERVICES = basic_services
NATIVE_FEATURE_SERVICE_TYPES = {"relationships", "follow_up"}
EXTENDED_SERVICES = [
    service
    for service in advanced_services
    if getattr(service, "service_type", None) not in NATIVE_FEATURE_SERVICE_TYPES
]


def _get_providers(config: CapabilityConfig) -> list:
    result = []
    if not config.disable_basic:
        providers_to_add = BASIC_PROVIDERS
        if config.skip_character_provider:
            providers_to_add = [p for p in providers_to_add if p.name != "CHARACTER"]
        result.extend(providers_to_add)
    if config.enable_extended:
        result.extend(EXTENDED_PROVIDERS)
    # Core capabilities
    if config.enable_trust:
        from elizaos.features.core_capabilities.trust import trust_providers

        result.extend(trust_providers)
    if config.enable_secrets_manager:
        from elizaos.features.core_capabilities.secrets import secrets_providers

        result.extend(secrets_providers)
    if config.enable_plugin_manager:
        from elizaos.features.core_capabilities.plugin_manager import plugin_manager_providers

        result.extend(plugin_manager_providers)
    return result


def _get_actions(config: CapabilityConfig) -> list:
    result = []
    if not config.disable_basic:
        result.extend(BASIC_ACTIONS)
    if config.enable_extended:
        result.extend(EXTENDED_ACTIONS)
    # Core capabilities
    if config.enable_trust:
        from elizaos.features.core_capabilities.trust import trust_actions

        result.extend(trust_actions)
    if config.enable_secrets_manager:
        from elizaos.features.core_capabilities.secrets import secrets_actions

        result.extend(secrets_actions)
    if config.enable_plugin_manager:
        from elizaos.features.core_capabilities.plugin_manager import plugin_manager_actions

        result.extend(plugin_manager_actions)
    return result


def _get_evaluators(config: CapabilityConfig) -> list:
    result = []
    if not config.disable_basic:
        result.extend(BASIC_EVALUATORS)
    if config.enable_extended:
        result.extend(EXTENDED_EVALUATORS)
    # Core capabilities
    if config.enable_trust:
        from elizaos.features.core_capabilities.trust import trust_evaluators

        result.extend(trust_evaluators)
    return result


def _get_services(config: CapabilityConfig) -> list[type]:
    result = []
    if not config.disable_basic:
        result.extend(BASIC_SERVICES)
    if config.enable_extended:
        result.extend(EXTENDED_SERVICES)
    # Core capabilities
    if config.enable_trust:
        from elizaos.features.core_capabilities.trust import (
            SecurityModuleService,
            TrustEngineService,
        )

        result.extend([TrustEngineService, SecurityModuleService])
    if config.enable_secrets_manager:
        from elizaos.features.core_capabilities.secrets import SecretsService

        result.append(SecretsService)
    if config.enable_plugin_manager:
        from elizaos.features.core_capabilities.plugin_manager import PluginManagerService

        result.append(PluginManagerService)
    return result


def create_basic_capabilities_plugin(config: CapabilityConfig | None = None) -> Plugin:
    """Create a basic_capabilities plugin with the specified capability configuration."""
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
        _ = plugin_config
        runtime.logger.info(
            "Initializing BasicCapabilities plugin",
            src="plugin:basic_capabilities",
            agentId=str(runtime.agent_id),
        )

    return Plugin(
        name="basic_capabilities",
        description="elizaOS BasicCapabilities Plugin - core agent actions, providers, evaluators, and services",
        init=init_plugin,
        config={},
        services=services,
        actions=actions,
        providers=providers,
        evaluators=evaluators,
    )


basic_capabilities_plugin = create_basic_capabilities_plugin()

__all__ = [
    "basic_capabilities_plugin",
    "create_basic_capabilities_plugin",
    "CapabilityConfig",
    "EvaluatorResult",
]
