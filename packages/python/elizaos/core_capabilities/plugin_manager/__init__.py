"""Plugin manager sub-module.

Read-only plugin discovery and plugin/core status introspection.
Ported from plugin-plugin-manager TypeScript.
"""

from .actions import (
    core_status_action,
    list_ejected_action,
    plugin_manager_actions,
    search_plugin_action,
)
from .providers import (
    plugin_configuration_status_provider,
    plugin_manager_providers,
    plugin_state_provider,
    registry_plugins_provider,
)
from .service import PluginManagerService
from .services import CoreManagerService, PluginRegistryService, plugin_manager_services
from .types import (
    PROTECTED_PLUGINS,
    ComponentRegistration,
    EjectedPluginInfo,
    InstallProgress,
    InstallResult,
    PluginComponents,
    PluginManagerConfig,
    PluginMetadata,
    PluginSearchResult,
    PluginState,
    PluginStatus,
    RegistryPlugin,
    UninstallResult,
    UpstreamMetadata,
)

__all__ = [
    # Services
    "PluginManagerService",
    "CoreManagerService",
    "PluginRegistryService",
    "plugin_manager_services",
    # Actions
    "plugin_manager_actions",
    "core_status_action",
    "search_plugin_action",
    "list_ejected_action",
    # Providers
    "plugin_manager_providers",
    "plugin_state_provider",
    "plugin_configuration_status_provider",
    "registry_plugins_provider",
    # Types
    "PluginStatus",
    "PluginState",
    "PluginComponents",
    "ComponentRegistration",
    "PluginMetadata",
    "PluginManagerConfig",
    "InstallProgress",
    "InstallResult",
    "UninstallResult",
    "PROTECTED_PLUGINS",
    "EjectedPluginInfo",
    "UpstreamMetadata",
    "PluginSearchResult",
    "RegistryPlugin",
]
