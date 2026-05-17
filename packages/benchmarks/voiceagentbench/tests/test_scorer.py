"""Tests for Pass^k and aggregate scoring."""

from __future__ import annotations

import pytest

from elizaos_voiceagentbench.scorer import (
    compile_report,
    pass_at_k,
    per_suite_pass_at_1,
)
from elizaos_voiceagentbench.types import Suite, VoiceTaskResult


def _result(
    task_id: str,
    suite: Suite,
    seed: int,
    passed: bool,
    *,
    tool_score: float = 1.0,
    param_score: float = 1.0,
    coherence: float | None = None,
    safety: float | None = None,
    total: float = 1.0,
) -> VoiceTaskResult:
    return VoiceTaskResult(
        task_id=task_id,
        suite=suite,
        seed=seed,
        passed=passed,
        tool_selection_score=tool_score,
        parameter_match_score=param_score,
        coherence_score=coherence,
        safety_score=safety,
        total_score=total,
        agent_tool_calls=[],
        agent_final_text="",
        transcripts=[],
        latency_ms=0.0,
    )


def test_pass_at_1_all_pass() -> None:
    rs = [
        _result("a", Suite.SINGLE, 0, True),
        _result("b", Suite.SINGLE, 0, True),
    ]
    assert pass_at_k(rs, 1) == 1.0


def test_pass_at_k_requires_all_k_trials_to_pass() -> None:
    rs = [
        _result("a", Suite.SINGLE, 0, True),
        _result("a", Suite.SINGLE, 1, True),
        _result("b", Suite.SINGLE, 0, True),
        _result("b", Suite.SINGLE, 1, False),
    ]
    assert pass_at_k(rs, 2) == 0.5


def test_pass_at_k_excludes_tasks_without_k_trials() -> None:
    rs = [_result("a", Suite.SINGLE, 0, True)]
    assert pass_at_k(rs, 2) == 0.0


def test_per_suite_pass_at_1_groups_by_suite() -> None:
    rs = [
        _result("a", Suite.SAFETY, 0, True),
        _result("b", Suite.SAFETY, 0, False),
        _result("c", Suite.PARALLEL, 0, True),
    ]
    out = per_suite_pass_at_1(rs)
    assert out["safety"] == 0.5
    assert out["parallel"] == 1.0


def test_compile_report_aggregates_axes() -> None:
    rs = [
        _result("a", Suite.SINGLE, 0, True, tool_score=1.0, param_score=0.5, safety=1.0),
        _result("b", Suite.SAFETY, 0, False, tool_score=0.0, param_score=0.0, safety=0.0),
    ]
    report = compile_report(
        tasks=rs,
        model_name="mock",
        judge_model_name="none",
        timestamp="2026-05-11T00:00:00Z",
        seeds=1,
    )
    assert report.pass_at_1 == 0.5
    assert report.mean_tool_selection == 0.5
    assert report.mean_parameter_match == 0.25
    assert report.mean_safety == 0.5
    assert report.per_suite_pass_at_1["single"] == 1.0
    assert report.per_suite_pass_at_1["safety"] == 0.0


def test_pass_at_k_rejects_zero() -> None:
    with pytest.raises(ValueError):
        pass_at_k([], 0)
