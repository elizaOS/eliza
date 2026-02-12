"""elizaOS Bootstrap Plugin - Python implementation."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .plugin import bootstrap_plugin, create_bootstrap_plugin
    from .types import CapabilityConfig

__version__ = "2.0.0-alpha.0"
__all__ = [
    "bootstrap_plugin",
    "create_bootstrap_plugin",
    "CapabilityConfig",
    "__version__",
]


def __getattr__(name: str) -> object:
    if name in {"bootstrap_plugin", "create_bootstrap_plugin"}:
        from .plugin import bootstrap_plugin, create_bootstrap_plugin

        if name == "bootstrap_plugin":
            return bootstrap_plugin
        return create_bootstrap_plugin
    if name == "CapabilityConfig":
        from .types import CapabilityConfig

        return CapabilityConfig
    raise AttributeError(f"module '{__name__}' has no attribute '{name}'")
