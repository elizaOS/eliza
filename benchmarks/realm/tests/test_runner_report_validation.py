import random

import pytest

from benchmarks.realm.runner import REALMRunner
from benchmarks.realm.types import REALMConfig


@pytest.mark.asyncio
async def test_runner_report_invariants_with_mock_agent() -> None:
    random.seed(0)

    config = REALMConfig(
        data_path="./does-not-exist",
        output_dir="./benchmark_results/realm/_test",
        max_tasks_per_category=1,  # 1 per category = 6 tasks
        generate_report=False,
        save_trajectories=False,
        save_detailed_logs=False,
    )

    runner = REALMRunner(config, use_mock=True)
    report = await runner.run_benchmark()

    # Basic invariants
    assert report.metrics.total_tasks == len(report.results)
    assert report.metrics.passed_tasks + report.metrics.failed_tasks == report.metrics.total_tasks

    # Category breakdown sums should match total
    total_from_breakdown = 0
    for data in report.category_breakdown.values():
        total_val = data.get("total")
        assert isinstance(total_val, (int, float))
        total_from_breakdown += int(total_val)

    assert total_from_breakdown == report.metrics.total_tasks

