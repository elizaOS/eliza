"""Tests for the VisualWebBench package.

These tests use the offline labeled JSONL fixture and the ``--mock`` oracle to
verify that the right per-subtask metric runs end-to-end for every subtask.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from benchmarks.visualwebbench.agent import OracleVisualWebBenchAgent
from benchmarks.visualwebbench.dataset import VisualWebBenchDataset
from benchmarks.visualwebbench.evaluator import VisualWebBenchEvaluator
from benchmarks.visualwebbench.runner import VisualWebBenchRunner
from benchmarks.visualwebbench.types import (
    VISUALWEBBENCH_TASK_TYPES,
    VisualWebBenchConfig,
    VisualWebBenchPrediction,
    VisualWebBenchTask,
    VisualWebBenchTaskType,
)
from eliza_adapter.visualwebbench import _build_app_harness_invocation


# --------------------------------------------------------------------------- #
# Metric unit tests — one per subtask
# --------------------------------------------------------------------------- #


def _evaluate(task: VisualWebBenchTask, *, answer_text: str = "", choice_index=None):
    return VisualWebBenchEvaluator().evaluate(
        task,
        VisualWebBenchPrediction(
            task_id=task.id,
            task_type=task.task_type,
            answer_text=answer_text,
            choice_index=choice_index,
        ),
    )


def test_web_caption_uses_rouge():
    task = VisualWebBenchTask(
        id="cap-1",
        task_type=VisualWebBenchTaskType.WEB_CAPTION,
        website="ex.test",
        prompt="caption it",
        answer="A product listing page for hiking backpacks",
    )
    result = _evaluate(task, answer_text="A product listing page for hiking backpacks")
    assert result.score_kind == "rouge"
    assert set(result.metrics) == {"rouge_1", "rouge_2", "rouge_l"}
    assert result.metrics["rouge_l"] > 99.0  # near-perfect match


def test_heading_ocr_uses_rouge():
    task = VisualWebBenchTask(
        id="head-1",
        task_type=VisualWebBenchTaskType.HEADING_OCR,
        website="ex.test",
        prompt="read heading",
        answer="Morning Market Brief",
    )
    result = _evaluate(task, answer_text="Morning Market Brief")
    assert result.score_kind == "rouge"
    assert result.metrics["rouge_l"] > 99.0


def test_element_ocr_uses_rouge():
    task = VisualWebBenchTask(
        id="el-1",
        task_type=VisualWebBenchTaskType.ELEMENT_OCR,
        website="ex.test",
        prompt="ocr",
        answer="Book now",
    )
    result = _evaluate(task, answer_text="The text is: Book now")
    assert result.score_kind == "rouge"
    # Partial overlap so rouge_l < 100 but > 0.
    assert 0.0 < result.metrics["rouge_l"] < 100.0


def test_webqa_uses_f1_with_reference_list():
    task = VisualWebBenchTask(
        id="qa-1",
        task_type=VisualWebBenchTaskType.WEBQA,
        website="ex.test",
        prompt="What is the APR?",
        answer=["4.25%", "4.25 percent"],
        question="What is the APR?",
    )
    result = _evaluate(task, answer_text="4.25 percent")
    assert result.score_kind == "f1"
    assert set(result.metrics) == {"f1"}
    assert result.metrics["f1"] > 99.0


def test_element_ground_uses_choice_letter():
    task = VisualWebBenchTask(
        id="eg-1",
        task_type=VisualWebBenchTaskType.ELEMENT_GROUND,
        website="ex.test",
        prompt="which element?",
        options=[(0.1, 0.1, 0.2, 0.2), (0.5, 0.5, 0.7, 0.7), (0.7, 0.7, 0.9, 0.9)],
        answer=2,
    )
    result = _evaluate(task, answer_text="C")
    assert result.score_kind == "choice"
    assert result.metrics == {"accuracy": 100.0}
    assert result.success


def test_action_prediction_uses_choice():
    task = VisualWebBenchTask(
        id="ap-1",
        task_type=VisualWebBenchTaskType.ACTION_PREDICTION,
        website="ex.test",
        prompt="action?",
        options=["open", "submit", "clear"],
        answer=1,
    )
    result = _evaluate(task, answer_text="B")
    assert result.score_kind == "choice"
    assert result.success


def test_action_ground_uses_choice():
    task = VisualWebBenchTask(
        id="ag-1",
        task_type=VisualWebBenchTaskType.ACTION_GROUND,
        website="ex.test",
        prompt="which?",
        options=[(0.1, 0.1, 0.2, 0.2), (0.5, 0.5, 0.7, 0.7), (0.7, 0.7, 0.9, 0.9)],
        answer=0,
    )
    result = _evaluate(task, answer_text="A")
    assert result.score_kind == "choice"
    assert result.success


def test_choice_letter_parser_handles_sentences():
    task = VisualWebBenchTask(
        id="ag-2",
        task_type=VisualWebBenchTaskType.ACTION_GROUND,
        website="ex.test",
        prompt="which?",
        options=[(0, 0, 0.1, 0.1)] * 4,
        answer=2,
    )
    result = _evaluate(task, answer_text="I think the answer is (C).")
    assert result.success


def test_choice_letter_parser_rejects_wrong_letter():
    task = VisualWebBenchTask(
        id="eg-2",
        task_type=VisualWebBenchTaskType.ELEMENT_GROUND,
        website="ex.test",
        prompt="which?",
        options=[(0, 0, 0.1, 0.1)] * 4,
        answer=2,
    )
    result = _evaluate(task, answer_text="A")
    assert not result.success
    assert result.metrics == {"accuracy": 0.0}


def test_prediction_error_forces_zero_score():
    task = VisualWebBenchTask(
        id="qa-err",
        task_type=VisualWebBenchTaskType.WEBQA,
        website="ex.test",
        prompt="?",
        answer=["x"],
    )
    result = VisualWebBenchEvaluator().evaluate(
        task,
        VisualWebBenchPrediction(
            task_id=task.id,
            task_type=task.task_type,
            answer_text="x",
            error="agent failed",
        ),
    )
    assert result.score == 0.0
    assert not result.success
    assert result.error == "agent failed"


# --------------------------------------------------------------------------- #
# Dataset loading
# --------------------------------------------------------------------------- #


def test_jsonl_fixture_loads_all_seven_subtasks():
    ds = VisualWebBenchDataset()
    asyncio.run(ds.load(use_huggingface=False, use_sample_tasks=True))
    loaded_types = {t.task_type for t in ds.tasks}
    assert loaded_types == set(VISUALWEBBENCH_TASK_TYPES)


def test_dataset_refuses_to_load_with_no_source():
    ds = VisualWebBenchDataset()
    with pytest.raises(RuntimeError):
        asyncio.run(ds.load(use_huggingface=False, use_sample_tasks=False))


# --------------------------------------------------------------------------- #
# Runner — one sample per subtask, with the oracle, verifies right metric runs
# --------------------------------------------------------------------------- #


def test_runner_smoke_one_per_subtask(tmp_path: Path) -> None:
    config = VisualWebBenchConfig(
        output_dir=str(tmp_path),
        mock=True,
        use_huggingface=False,
        use_sample_tasks=True,
    )
    report = asyncio.run(VisualWebBenchRunner(config).run_benchmark())

    assert report.total_tasks == 7
    seen = {tt for tt in report.by_task_type}
    assert seen == {t.value for t in VISUALWEBBENCH_TASK_TYPES}

    for tt, agg in report.by_task_type.items():
        # Oracle always gives the right answer; check the right metric ran.
        if tt in {"web_caption", "heading_ocr", "element_ocr"}:
            assert "rouge_l" in agg
            assert agg["rouge_l"] > 50.0
        elif tt == "webqa":
            assert "f1" in agg
            assert agg["f1"] > 50.0
        else:
            assert "accuracy" in agg
            assert agg["accuracy"] == 100.0

    results_path = tmp_path / "visualwebbench-results.json"
    summary_path = tmp_path / "summary.md"
    trace_dir = tmp_path / "traces"
    assert results_path.exists()
    assert summary_path.exists()
    assert trace_dir.exists()
    assert len(list(trace_dir.glob("*.json"))) == 7

    data = json.loads(results_path.read_text())
    assert data["benchmark"] == "visualwebbench"
    assert data["total_tasks"] == 7


def test_runner_refuses_without_mock_or_provider() -> None:
    config = VisualWebBenchConfig(
        mock=False,
        provider="unknown-provider",
        use_huggingface=False,
        use_sample_tasks=True,
    )
    runner = VisualWebBenchRunner(config)
    # Load tasks before exercising the agent picker so we don't hit HF.
    asyncio.run(runner.dataset.load(use_huggingface=False, use_sample_tasks=True))
    with pytest.raises(ValueError, match="VisualWebBench requires --mock"):
        runner._create_agent()


def test_oracle_agent_only_returned_when_mock_is_set() -> None:
    mock_cfg = VisualWebBenchConfig(mock=True, use_sample_tasks=True, use_huggingface=False)
    runner = VisualWebBenchRunner(mock_cfg)
    assert isinstance(runner._create_agent(), OracleVisualWebBenchAgent)


# --------------------------------------------------------------------------- #
# App-harness invocation (regression coverage from the old test file)
# --------------------------------------------------------------------------- #


def test_app_harness_invocation_uses_ui_prompt_by_default(tmp_path: Path) -> None:
    task = VisualWebBenchTask(
        id="webqa-fixture",
        task_type=VisualWebBenchTaskType.WEBQA,
        website="example.com/page",
        prompt="What is the title?",
        answer=["Example"],
        question="What is the title?",
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
    assert "--prompt-via-ui" in invocation.command
    assert "--no-launch" in invocation.command
    assert "--target-url" in invocation.command
    assert "visualwebbench" in invocation.prompt


def test_app_harness_invocation_can_use_api_prompt_fallback(tmp_path: Path) -> None:
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
