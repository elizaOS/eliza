from __future__ import annotations

import asyncio
import json

from benchmarks.visualwebbench.evaluator import VisualWebBenchEvaluator
from benchmarks.visualwebbench.runner import VisualWebBenchRunner
from benchmarks.visualwebbench.types import (
    VisualWebBenchConfig,
    VisualWebBenchPrediction,
    VisualWebBenchTask,
    VisualWebBenchTaskType,
)


def test_choice_and_bbox_scoring() -> None:
    task = VisualWebBenchTask(
        id="ground",
        task_type=VisualWebBenchTaskType.ELEMENT_GROUND,
        website="example.test",
        prompt="cart",
        options=[(0.1, 0.1, 0.2, 0.2), (0.5, 0.5, 0.7, 0.7)],
        answer=1,
    )
    evaluator = VisualWebBenchEvaluator()
    result = evaluator.evaluate(
        task,
        VisualWebBenchPrediction(
            task_id=task.id,
            task_type=task.task_type,
            bbox=(0.51, 0.51, 0.69, 0.69),
        ),
    )
    assert result.success
    assert result.bbox_iou is not None
    assert result.bbox_iou >= 0.5


def test_runner_writes_required_artifacts(tmp_path) -> None:
    config = VisualWebBenchConfig(output_dir=str(tmp_path), dry_run=True, max_tasks=2)
    report = asyncio.run(VisualWebBenchRunner(config).run_benchmark())

    assert report.total_tasks == 2
    results_path = tmp_path / "visualwebbench-results.json"
    summary_path = tmp_path / "summary.md"
    trace_dir = tmp_path / "traces"
    assert results_path.exists()
    assert summary_path.exists()
    assert trace_dir.exists()

    data = json.loads(results_path.read_text())
    assert data["benchmark"] == "visualwebbench"
    assert data["overall_accuracy"] == 1.0
