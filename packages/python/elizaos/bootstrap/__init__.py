"""elizaOS Bootstrap Plugin - Python implementation."""

from .plugin import bootstrap_plugin, create_bootstrap_plugin
from .types import CapabilityConfig

__version__ = "2.0.0-alpha.0"
__all__ = [
    "bootstrap_plugin",
    "create_bootstrap_plugin",
    "CapabilityConfig",
    "__version__",
]
