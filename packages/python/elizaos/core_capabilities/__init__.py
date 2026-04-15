"""Core Capabilities module.

Provides trust, secrets manager, and plugin manager capabilities that can
be conditionally enabled via ``CapabilityConfig`` in
``elizaos.basic_capabilities_compat``.

Each sub-module is a self-contained Python port of the corresponding
TypeScript plugin:

- **trust** -- multi-dimensional trust scoring, security threat detection
  (from ``plugin-trust``)
- **secrets** -- multi-level secret management with AES-256-GCM encryption
  (from ``plugin-secrets-manager``)
- **plugin_manager** -- read-only plugin discovery and status introspection
  (from ``plugin-plugin-manager``)
"""

from .plugin_manager import (
    CoreManagerService,
    PluginManagerService,
    PluginRegistryService,
    core_status_action,
    list_ejected_action,
    plugin_configuration_status_provider,
    plugin_manager_actions,
    plugin_manager_providers,
    plugin_manager_services,
    plugin_state_provider,
    registry_plugins_provider,
    search_plugin_action,
)
from .secrets import (
    KeyManager,
    OnboardingService,
    PluginActivatorService,
    SecretsService,
    manage_secret_action,
    missing_secrets_provider,
    onboarding_settings_provider,
    request_secret_action,
    secrets_actions,
    secrets_providers,
    secrets_status_provider,
    set_secret_action,
)
from .secrets import (
    update_settings_action as onboarding_update_settings_action,
)
from .trust import (
    SecurityModuleService,
    TrustEngineService,
    admin_trust_provider,
    evaluate_trust_action,
    record_interaction_action,
    reflection_evaluator,
    request_elevation_action,
    role_provider,
    security_evaluator,
    security_status_provider,
    settings_provider,
    trust_actions,
    trust_change_evaluator,
    trust_evaluators,
    trust_profile_provider,
    trust_providers,
    update_role_action,
    update_settings_action,
)

# Aggregate lists for use by basic_capabilities_compat
core_capability_actions = trust_actions + secrets_actions + plugin_manager_actions
core_capability_providers = trust_providers + secrets_providers + plugin_manager_providers
core_capability_evaluators = trust_evaluators
core_capability_services: list[type] = [
    TrustEngineService,
    SecurityModuleService,
    SecretsService,
    OnboardingService,
    PluginActivatorService,
    PluginManagerService,
    CoreManagerService,
    PluginRegistryService,
]

__all__ = [
    # Aggregate lists
    "core_capability_actions",
    "core_capability_providers",
    "core_capability_evaluators",
    "core_capability_services",
    # Trust
    "TrustEngineService",
    "SecurityModuleService",
    "trust_actions",
    "evaluate_trust_action",
    "record_interaction_action",
    "request_elevation_action",
    "update_role_action",
    "update_settings_action",
    "trust_providers",
    "trust_profile_provider",
    "security_status_provider",
    "admin_trust_provider",
    "role_provider",
    "settings_provider",
    "trust_evaluators",
    "security_evaluator",
    "trust_change_evaluator",
    "reflection_evaluator",
    # Secrets
    "SecretsService",
    "KeyManager",
    "secrets_actions",
    "set_secret_action",
    "manage_secret_action",
    "request_secret_action",
    "secrets_providers",
    "secrets_status_provider",
    # Secrets - Onboarding
    "OnboardingService",
    "onboarding_update_settings_action",
    "onboarding_settings_provider",
    "missing_secrets_provider",
    # Secrets - Plugin Activator
    "PluginActivatorService",
    # Plugin Manager
    "PluginManagerService",
    "CoreManagerService",
    "PluginRegistryService",
    "plugin_manager_services",
    "plugin_manager_actions",
    "core_status_action",
    "search_plugin_action",
    "list_ejected_action",
    "plugin_manager_providers",
    "plugin_state_provider",
    "plugin_configuration_status_provider",
    "registry_plugins_provider",
]
