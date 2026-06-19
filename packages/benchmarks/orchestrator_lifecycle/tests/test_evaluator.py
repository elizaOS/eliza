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


def test_evaluator_accepts_equivalent_updated_plan_wording() -> None:
    evaluator = LifecycleEvaluator()
    scenario = Scenario(
        scenario_id="scope_case",
        title="Scope Case",
        category="interruption",
        turns=[
            ScenarioTurn(
                actor="user",
                message="continue with the updated scope",
                expected_behaviors=["apply_scope_change_to_task"],
            )
        ],
    )

    result = evaluator.evaluate_scenario(
        scenario,
        ["The updated scope has been applied; the plan is now updated accordingly."],
    )

    assert result.passed
    assert result.score == 1.0


def test_evaluator_accepts_equivalent_status_and_wait_wording() -> None:
    evaluator = LifecycleEvaluator()
    scenario = Scenario(
        scenario_id="research_and_clarify_case",
        title="Research And Clarify Case",
        category="capability",
        turns=[
            ScenarioTurn(
                actor="user",
                message="Research the latest policy docs.",
                expected_behaviors=["spawn_subagent", "report_active_subagent_status"],
            ),
            ScenarioTurn(
                actor="user",
                message="Not sure what to prioritize.",
                expected_behaviors=["do_not_start_without_required_info"],
            ),
        ],
    )

    result = evaluator.evaluate_scenario(
        scenario,
        [
            "I will delegate this task to a subagent. Subagent delegated to gather the latest policy docs.",
            "I need more detail before proceeding.",
        ],
    )

    assert result.passed
    assert result.score == 1.0


def test_evaluator_accepts_live_transcript_paraphrases() -> None:
    evaluator = LifecycleEvaluator()
    scenario = Scenario(
        scenario_id="live_paraphrases",
        title="Live Paraphrases",
        category="lifecycle",
        turns=[
            ScenarioTurn(
                actor="user",
                message="Change scope.",
                expected_behaviors=["apply_scope_change_to_task"],
            ),
            ScenarioTurn(
                actor="user",
                message="Implement fix.",
                expected_behaviors=["report_active_subagent_status"],
            ),
            ScenarioTurn(
                actor="user",
                message="Research docs.",
                expected_behaviors=["report_active_subagent_status"],
            ),
            ScenarioTurn(
                actor="user",
                message="Handle that thing.",
                expected_behaviors=[
                    "ask_clarifying_question_before_start",
                    "do_not_start_without_required_info",
                ],
            ),
        ],
    )

    result = evaluator.evaluate_scenario(
        scenario,
        [
            "I acknowledged the scope change and applied it by updating the plan accordingly.",
            "Delegating to a subagent to implement the login timeout fix; will keep you updated.",
            "Delegated to a subagent; the subagent has been spawned to research the latest docs.",
            "Could you remind me which task you’re referring to, and what outcomes you’d like to prioritize?",
        ],
    )

    assert result.passed
    assert result.score == 1.0
