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
    from elizaos_plugin_bootstrap import bootstrap_plugin

    # Register with runtime
    await runtime.register_plugin(bootstrap_plugin)
"""

from .plugin import bootstrap_plugin

__version__ = "2.0.0-alpha.0"
__all__ = ["bootstrap_plugin", "__version__"]
