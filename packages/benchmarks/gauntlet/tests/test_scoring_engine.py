"""Regression tests for Gauntlet scoring semantics."""

from gauntlet.harness.metrics_collector import LevelMetrics, RunMetrics
from gauntlet.scoring.engine import ScoringEngine


def test_level_pass_uses_level_specific_metric() -> None:
    run = RunMetrics(
        run_id="run",
        agent_id="agent",
        benchmark_version="test",
        seed=1,
    )
    run.level_metrics = {
        2: LevelMetrics(
            level=2,
            total_tasks=1,
            task_completion_rate=0.0,
            cu_efficiency=80.0,
            capital_preserved=100.0,
        ),
        3: LevelMetrics(
            level=3,
            total_tasks=1,
            task_completion_rate=0.0,
            safety_score=85.0,
            capital_preserved=100.0,
        ),
    }

    score = ScoringEngine().score_overall(run)

    assert score.level_scores[2].passed is True
    assert score.level_scores[3].passed is True


def test_zero_task_completion_levels_are_not_dropped_from_average() -> None:
    run = RunMetrics(
        run_id="run",
        agent_id="agent",
        benchmark_version="test",
        seed=1,
    )
    run.level_metrics = {
        0: LevelMetrics(
            level=0,
            total_tasks=1,
            task_completion_rate=100.0,
            capital_preserved=100.0,
        ),
        1: LevelMetrics(
            level=1,
            total_tasks=1,
            task_completion_rate=0.0,
            capital_preserved=100.0,
        ),
    }

    score = ScoringEngine().score_overall(run)

    assert score.avg_task_completion == 50.0
    assert score.passed is False
