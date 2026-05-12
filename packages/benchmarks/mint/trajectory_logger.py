"""Compatibility stubs for the removed Python MINT trajectory integration.

MINT no longer instruments a Python Eliza runtime. Real Eliza runs go through
the TypeScript benchmark bridge, which owns runtime-side trajectory logging.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class TrajectoryLoggingConfig:
    dataset_name: str
    output_dir: Path


def instrument_runtime_for_trajectory_logging(runtime: object, logger_service: object) -> None:
    """No-op retained for older callers."""
    _ = (runtime, logger_service)


def export_benchmark_trajectories(
    *,
    logger_service: object,
    trajectory_ids: list[str],
    config: TrajectoryLoggingConfig,
) -> None:
    """No-op retained for older callers."""
    _ = (logger_service, trajectory_ids, config)
