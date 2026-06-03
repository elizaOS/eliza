from __future__ import annotations

from pathlib import Path

from benchmarks.mint.trajectory_logger import (
    TrajectoryLoggingConfig,
    export_benchmark_trajectories,
    instrument_runtime_for_trajectory_logging,
)


def test_trajectory_logger_compatibility_noops_are_side_effect_free(tmp_path: Path) -> None:
    runtime = {"name": "legacy-runtime"}
    logger_service = {"name": "legacy-logger"}
    config = TrajectoryLoggingConfig(dataset_name="mint", output_dir=tmp_path)

    assert instrument_runtime_for_trajectory_logging(runtime, logger_service) is None
    assert (
        export_benchmark_trajectories(
            logger_service=logger_service,
            trajectory_ids=["traj-1"],
            config=config,
        )
        is None
    )
    assert config.output_dir == tmp_path
