"""
elizaOS Bootstrap Plugin - Python implementation of core agent actions,
providers, evaluators, and services.

This package provides the foundational components that every elizaOS
agent needs to function, including:

- Actions: REPLY, IGNORE, FOLLOW_ROOM, etc.
- Providers: CHARACTER, RECENT_MESSAGES, WORLD, etc.
- Evaluators: GOAL, REFLECTION
- Services: Task management, Embedding

Usage:
    from elizaos.bootstrap import bootstrap_plugin

    # Register with runtime (auto-included by default)
    await runtime.register_plugin(bootstrap_plugin)

    # Or create a custom-configured plugin
    from elizaos.bootstrap import create_bootstrap_plugin, CapabilityConfig
    plugin = create_bootstrap_plugin(CapabilityConfig(enable_extended=True))
"""

from .plugin import bootstrap_plugin, create_bootstrap_plugin
from .types import CapabilityConfig

__version__ = "2.0.0-alpha.0"
__all__ = [
    "bootstrap_plugin",
    "create_bootstrap_plugin",
    "CapabilityConfig",
    "__version__",
]
