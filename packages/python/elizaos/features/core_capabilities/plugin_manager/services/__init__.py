"""Plugin manager services."""

from .core_manager_service import CoreManagerService
from .plugin_registry_service import PluginRegistryService

plugin_manager_services: list[type] = [CoreManagerService, PluginRegistryService]

__all__ = [
    "CoreManagerService",
    "PluginRegistryService",
    "plugin_manager_services",
]
