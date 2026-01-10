"""
elizaOS Python Plugin Starter

A template for creating elizaOS plugins in Python that can be loaded by:
- Python runtime (native)
- TypeScript runtime (via IPC bridge)

Example:
    >>> from elizaos_plugin_starter import plugin
    >>> await runtime.register_plugin(plugin)
"""

from elizaos_plugin_starter.plugin import plugin, StarterService

__all__ = ["plugin", "StarterService"]
__version__ = "1.0.0"
