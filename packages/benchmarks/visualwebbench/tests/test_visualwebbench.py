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
from eliza_adapter.visualwebbench import _build_app_harness_invocation


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


def test_prediction_error_forces_zero_score() -> None:
    task = VisualWebBenchTask(
        id="exact-error",
        task_type=VisualWebBenchTaskType.WEBQA,
        website="example.test",
        prompt="What is the title?",
        answer="Example",
    )
    evaluator = VisualWebBenchEvaluator()
    result = evaluator.evaluate(
        task,
        VisualWebBenchPrediction(
            task_id=task.id,
            task_type=task.task_type,
            answer_text="Example",
            error="harness failed",
        ),
    )
    assert not result.success
    assert result.score == 0.0
    assert result.error == "harness failed"


def test_exact_scoring_accepts_answer_in_sentence() -> None:
    task = VisualWebBenchTask(
        id="webqa",
        task_type=VisualWebBenchTaskType.WEBQA,
        website="example.test",
        prompt="What is the APR?",
        answer=["4.25%", "4.25 percent"],
    )
    evaluator = VisualWebBenchEvaluator()

    result = evaluator.evaluate(
        task,
        VisualWebBenchPrediction(
            task_id=task.id,
            task_type=task.task_type,
            answer_text="The APR shown is 4.25%.",
        ),
    )

    assert result.success


def test_choice_scoring_accepts_letter_and_one_indexed_text() -> None:
    task = VisualWebBenchTask(
        id="choice",
        task_type=VisualWebBenchTaskType.ACTION_PREDICTION,
        website="example.test",
        prompt="What action?",
        options=["open", "submit", "clear"],
        answer=1,
    )
    evaluator = VisualWebBenchEvaluator()

    letter_result = evaluator.evaluate(
        task,
        VisualWebBenchPrediction(
            task_id=task.id,
            task_type=task.task_type,
            answer_text="The answer is B.",
        ),
    )
    number_result = evaluator.evaluate(
        task,
        VisualWebBenchPrediction(
            task_id=task.id,
            task_type=task.task_type,
            answer_text="option 2",
        ),
    )

    assert letter_result.success
    assert number_result.success


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


def test_app_harness_invocation_uses_ui_prompt_by_default(tmp_path) -> None:
    task = VisualWebBenchTask(
        id="webqa fixture",
        task_type=VisualWebBenchTaskType.WEBQA,
        website="example.com/page",
        prompt="What is the title?",
        answer="Example",
    )
    config = VisualWebBenchConfig(
        output_dir=str(tmp_path),
        provider="eliza-app-harness",
        app_harness_script=tmp_path / "harness.mjs",
        app_harness_runtime="bun",
        timeout_ms=5000,
    )

    invocation = _build_app_harness_invocation(task, config, run_id="run-1")

    assert invocation.run_id == "run-1"
    assert invocation.target_url == "https://example.com/page"
    assert "--prompt-via-ui" in invocation.command
    assert "--prompt-via-api" not in invocation.command
    assert "--no-launch" in invocation.command
    assert "--target-url" in invocation.command
    assert "--require-browser-tab" in invocation.command
    assert "--require-browser-events" in invocation.command
    assert "--require-trajectory" in invocation.command
    assert "--require-browser-action" in invocation.command
    assert "visualwebbench" in invocation.prompt


def test_app_harness_invocation_can_use_api_prompt_fallback(tmp_path) -> None:
    task = VisualWebBenchTask(
        id="caption",
        task_type=VisualWebBenchTaskType.WEB_CAPTION,
        website="https://example.org/",
        prompt="Caption the page.",
        answer="Example",
    )
    config = VisualWebBenchConfig(
        output_dir=str(tmp_path),
        provider="eliza-app-harness",
        app_harness_script=tmp_path / "harness.mjs",
        app_harness_prompt_via_ui=False,
    )

    invocation = _build_app_harness_invocation(task, config, run_id="run-2")

    assert "--prompt-via-api" in invocation.command
    assert "--prompt-via-ui" not in invocation.command
