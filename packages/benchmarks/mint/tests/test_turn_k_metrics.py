"""
Smoke test: run a small end-to-end MINT benchmark and verify the canonical
Turn-1 / Turn-3 / Turn-5 success rates are actually populated.

Uses:
    * The hand-written smoke task set (``use_sample_tasks=True``) so this
      test does not depend on the vendored upstream JSON.
    * The templated feedback path so no LLM calls are made.
    * ``allow_ground_truth_mock=True`` so the agent emits the labeled answer
      and we can verify the metric pipeline end-to-end. This is opt-in and
      only used inside this single smoke test.
"""

from __future__ import annotations

import asyncio

import pytest

from benchmarks.mint.agent import MINTAgent
from benchmarks.mint.dataset import MINTDataset
from benchmarks.mint.evaluator import MINTEvaluator
from benchmarks.mint.feedback import FeedbackGenerator
from benchmarks.mint.metrics import MetricsCalculator
from benchmarks.mint.types import MINTSubtask


@pytest.mark.asyncio
async def test_turn_k_metrics_populated_via_smoke_dataset() -> None:
    dataset = MINTDataset(use_sample_tasks=True)
    await dataset.load()
    tasks = dataset.get_tasks()
    assert len(tasks) >= 2

    agent = MINTAgent(
        feedback_generator=FeedbackGenerator(mode="templated"),
        allow_ground_truth_mock=True,
    )
    evaluator = MINTEvaluator()
    results = []
    for task in tasks:
        traj = await agent.solve_task(task, enable_tools=False, enable_feedback=False)
        # The mock answer hits ground truth on turn 1.
        assert traj.per_turn_answers, "agent must record per-turn answers"
        result = evaluator.evaluate_trajectory(task, traj)
        results.append(result)

    metrics = MetricsCalculator().calculate(results, max_turns=5)

    assert metrics.total_tasks == len(tasks)
    # Per-turn cumulative SR must be set, not the zero defaults.
    assert len(metrics.per_turn_success_rates) == 5
    assert metrics.turn_1_success_rate > 0.0
    assert metrics.turn_5_success_rate >= metrics.turn_1_success_rate
    assert metrics.turn_3_success_rate >= metrics.turn_1_success_rate
    # The mock answers are correct on turn 1, so Turn-1 SR should equal final SR.
    assert metrics.turn_1_success_rate == pytest.approx(
        metrics.overall_success_rate
    )


@pytest.mark.asyncio
async def test_subtask_breakdown_present() -> None:
    dataset = MINTDataset(use_sample_tasks=True)
    await dataset.load()
    tasks = dataset.get_tasks()

    agent = MINTAgent(
        feedback_generator=FeedbackGenerator(mode="templated"),
        allow_ground_truth_mock=True,
    )
    evaluator = MINTEvaluator()
    results = []
    for task in tasks:
        traj = await agent.solve_task(task, enable_tools=False, enable_feedback=False)
        results.append(evaluator.evaluate_trajectory(task, traj))

    metrics = MetricsCalculator().calculate(results)
    # We seeded smoke tasks for these three subtasks.
    assert MINTSubtask.GSM8K in metrics.subtask_success_rates
    assert MINTSubtask.HUMANEVAL in metrics.subtask_success_rates
    assert MINTSubtask.MMLU in metrics.subtask_success_rates
