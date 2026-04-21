from __future__ import annotations

from pathlib import Path

from benchmarks.orchestrator_lifecycle.runner import LifecycleRunner
from benchmarks.orchestrator_lifecycle.types import LifecycleConfig


def test_runner_smoke(tmp_path: Path) -> None:
    config = LifecycleConfig(
        output_dir=str(tmp_path),
        scenario_dir="benchmarks/orchestrator_lifecycle/scenarios",
        max_scenarios=2,
    )
    runner = LifecycleRunner(config)
    results, metrics, report_path = runner.run()
    assert len(results) == 2
    assert metrics.total_scenarios == 2
    assert Path(report_path).exists()
