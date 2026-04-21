from __future__ import annotations

from benchmarks.orchestrator_lifecycle.evaluator import LifecycleEvaluator
from benchmarks.orchestrator_lifecycle.types import Scenario, ScenarioTurn


def test_evaluator_scores_expected_behavior() -> None:
    evaluator = LifecycleEvaluator()
    scenario = Scenario(
        scenario_id="clarification_case",
        title="Clarification Case",
        category="clarification",
        turns=[
            ScenarioTurn(
                actor="user",
                message="not sure what to do",
                expected_behaviors=["ask_clarifying_question_before_start"],
            )
        ],
    )
    result = evaluator.evaluate_scenario(
        scenario,
        ["I need more detail before starting, could you clarify scope?"],
    )
    assert result.passed
    assert result.score == 1.0
