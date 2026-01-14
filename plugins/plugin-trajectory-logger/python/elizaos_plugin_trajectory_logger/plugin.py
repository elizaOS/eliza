from __future__ import annotations

from elizaos.types.plugin import Plugin

from elizaos_plugin_trajectory_logger.runtime_service import TrajectoryLoggerRuntimeService


def get_trajectory_logger_plugin() -> Plugin:
    """Return an ElizaOS Plugin that registers the trajectory logger runtime service."""

    return Plugin(
        name="trajectory-logger",
        description="Trajectory logging utilities for training and benchmarks",
        services=[TrajectoryLoggerRuntimeService],
    )


plugin = get_trajectory_logger_plugin()
