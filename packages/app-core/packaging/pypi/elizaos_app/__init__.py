"""
elizaos_app — Dynamic loader for elizaOS App, a personal AI assistant built on elizaOS.

This package provides a Python entry point that dynamically loads and runs
the elizaOS App Node.js runtime. It handles Node.js detection, automatic
installation of the elizaos-app npm package, and seamless CLI delegation.

Usage (CLI):
    $ elizaos-app start
    $ elizaos-app setup
    $ elizaos-app --help

Usage (Python API):
    from elizaos_app import run, ensure_runtime, get_version

    # Ensure the runtime is ready
    ensure_runtime()

    # Run a command
    exit_code = run(["start"])

    # Get the installed version
    version = get_version()
"""

__version__ = "2.0.0a7"
__all__ = ["run", "ensure_runtime", "get_version", "ElizaOSAppError", "NodeNotFoundError"]

from elizaos_app.loader import (
    ElizaOSAppError,
    NodeNotFoundError,
    ensure_runtime,
    get_version,
    run,
)
