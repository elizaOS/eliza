"""No-op trajectory compatibility helpers for AgentBench.

The Python Eliza runtime path has been removed from benchmarks. Real Eliza
runs go through the TypeScript benchmark bridge, which owns runtime-side
trajectory logging.
"""

from __future__ import annotations

def is_trajectory_logging_available() -> bool:
    return False


def get_trajectory_logger_plugin():
    return None


def get_trajectory_logger_service(runtime: object):
    """
    Returns the trajectory logger service if registered; otherwise None.
    """
    get_service = getattr(runtime, "get_service", None)
    if not callable(get_service):
        return None
    return get_service("trajectory_logger")
