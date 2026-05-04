"""
AgentBench ↔ elizaos_plugin_trajectory_logger integration helpers.

AgentBench now integrates with the canonical trajectory logger *service* by:
- registering the plugin (`get_trajectory_logger_plugin()`) on the runtime
- attaching `trajectoryId` / `trajectoryStepId` to message metadata
- letting the core runtime pipeline log providers + LLM calls end-to-end
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from elizaos.runtime import AgentRuntime


def is_trajectory_logging_available() -> bool:
    try:
        import elizaos_plugin_trajectory_logger  # noqa: F401

        return True
    except ImportError:
        return False


def get_trajectory_logger_plugin():
    """
    Convenience wrapper.

    Import from `elizaos_plugin_trajectory_logger` in production code when possible.
    """
    from elizaos_plugin_trajectory_logger import get_trajectory_logger_plugin as _get

    return _get()


def get_trajectory_logger_service(runtime: "AgentRuntime"):
    """
    Returns the trajectory logger service if registered; otherwise None.
    """
    return runtime.get_service("trajectory_logger")
