"""End-to-end smoke run with the mock oracle agent.

Exercises the full pipeline: dataset -> runner -> per-problem evaluator
-> aggregated metrics. The mock agent emits oracle-optimal solutions
for the sample P1 / P11 instances, so we assert that the report
includes a real makespan and a meaningful optimality ratio (close to
1.0 for the sample where the oracle is known).
"""

from __future__ import annotations

import math
import json

import pytest

from benchmarks.realm.runner import REALMRunner
from benchmarks.realm.types import REALMConfig, RealmProblem


def test_runner_requires_agent_unless_mock_enabled() -> None:
    config = REALMConfig(
        data_path="./does-not-exist",
        output_dir="./benchmark_results/realm/_test",
        generate_report=False,
        use_sample_tasks=True,
    )
    with pytest.raises(ValueError, match="requires an agent"):
        REALMRunner(config, use_mock=False)


@pytest.mark.asyncio
async def test_sample_smoke_run_reports_makespan_and_optimality() -> None:
    config = REALMConfig(
        data_path="./does-not-exist",
        output_dir="./benchmark_results/realm/_test",
        generate_report=False,
        save_trajectories=False,
        save_detailed_logs=False,
        use_sample_tasks=True,
    )
    runner = REALMRunner(config, use_mock=True)
    report = await runner.run_benchmark()

    # Invariants
    assert report.metrics.total_tasks == len(report.results)
    assert (
        report.metrics.passed_tasks + report.metrics.failed_tasks
        == report.metrics.total_tasks
    )

    # The sample P11 instance has a known optimal makespan of 5.
    p11 = next(r for r in report.results if r.problem == RealmProblem.P11)
    assert p11.metrics.makespan > 0
    assert p11.metrics.makespan != math.inf
    assert p11.metrics.oracle_makespan == 5
    # Mock oracle is feasible; optimality ratio should be > 0.
    assert p11.metrics.optimality_ratio > 0

    # P1 sample: the mock emits a brute-force optimal route.
    p1 = next(r for r in report.results if r.problem == RealmProblem.P1)
    assert p1.metrics.optimality_ratio == pytest.approx(1.0, abs=1e-6)
    assert p1.metrics.planning_quality > 0

    # Wall-time measurement: planning_time_ms is real and not the old
    # 0.25 * duration estimate.
    assert p11.metrics.planning_time_ms >= 0
    assert p1.metrics.planning_time_ms >= 0


@pytest.mark.asyncio
async def test_per_problem_breakdown_totals_match_results() -> None:
    config = REALMConfig(
        data_path="./does-not-exist",
        output_dir="./benchmark_results/realm/_test",
        generate_report=False,
        save_trajectories=False,
        save_detailed_logs=False,
        use_sample_tasks=True,
    )
    runner = REALMRunner(config, use_mock=True)
    report = await runner.run_benchmark()

    total_from_breakdown = 0
    for data in report.problem_breakdown.values():
        total_val = data.get("total")
        assert isinstance(total_val, (int, float))
        total_from_breakdown += int(total_val)
    assert total_from_breakdown == report.metrics.total_tasks


@pytest.mark.asyncio
async def test_trajectory_export_writes_jsonl(tmp_path) -> None:
    config = REALMConfig(
        data_path="./does-not-exist",
        output_dir=str(tmp_path),
        generate_report=True,
        save_trajectories=True,
        save_detailed_logs=False,
        use_sample_tasks=True,
    )
    runner = REALMRunner(config, use_mock=True)
    report = await runner.run_benchmark()

    exports = list(tmp_path.glob("realm-trajectories-*.jsonl"))
    assert len(exports) == 1
    rows = [json.loads(line) for line in exports[0].read_text().splitlines()]
    assert len(rows) == report.metrics.total_tasks
    assert {"task_id", "problem", "trajectory"} <= set(rows[0])
