"""Backward-compatibility re-exports.  Exists-check logic now lives in
``PluginRegistryProvider`` (providers/registry.py).
"""

from elizaos_plugin_n8n.providers.registry import (
    PluginRegistryProvider,
    plugin_registry_provider,
)

# Legacy aliases – code that imports PluginExistsProvider or
# PluginExistsCheckProvider will get the merged PluginRegistryProvider.
PluginExistsProvider = PluginRegistryProvider
PluginExistsCheckProvider = PluginRegistryProvider

plugin_exists_provider = plugin_registry_provider
plugin_exists_check_provider = plugin_registry_provider

__all__ = [
    "PluginExistsProvider",
    "PluginExistsCheckProvider",
    "plugin_exists_provider",
    "plugin_exists_check_provider",
]
