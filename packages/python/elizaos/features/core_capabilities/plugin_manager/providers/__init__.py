"""Plugin manager providers."""

from .plugin_configuration_status import plugin_configuration_status_provider
from .plugin_state import plugin_state_provider
from .registry_plugins import registry_plugins_provider

plugin_manager_providers = [
    plugin_state_provider,
    plugin_configuration_status_provider,
    registry_plugins_provider,
]

__all__ = [
    "plugin_state_provider",
    "plugin_configuration_status_provider",
    "registry_plugins_provider",
    "plugin_manager_providers",
]
