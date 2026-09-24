"""Python launcher for the elizaOS App."""

from .loader import ensure_runtime, get_version, run

__version__ = "2.0.0b0"

__all__ = ["__version__", "ensure_runtime", "get_version", "run"]
