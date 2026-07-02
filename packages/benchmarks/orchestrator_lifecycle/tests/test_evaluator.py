"""Tests for the structural lifecycle evaluator (#9310 §3.11).

The old evaluator keyword-matched the agent's prose against a table the
system hint dictated verbatim ("include the word 'cancelled' AND a phrase
like 'execution stopped'"), and evaluated every per-turn expectation against
the whole-conversation blob. These tests pin the honest semantics: each user
turn is scored against the typed lifecycle events the agent emitted on that
turn, prose alone earns nothing, and empty/unknown checks never score a free
pass.
"""

from __future__ import annotations

from benchmarks.orchestrator_lifecycle.evaluator import LifecycleEvaluator
from benchmarks.orchestrator_lifecycle.types import Scenario, ScenarioTurn, TurnRecord


def _scenario(turns: list[ScenarioTurn], scenario_id: str = "case") -> Scenario:
    return Scenario(
        scenario_id=scenario_id,
        title=scenario_id,
        category="test",
        turns=turns,
    )


def test_typed_cancel_event_passes_cancel_checks() -> None:
    evaluator = LifecycleEvaluator()
    scenario = _scenario(
        [
            ScenarioTurn(
                actor="user",
                message="Cancel the task now.",
                expected_behaviors=["cancel_task", "confirm_cancel_effect"],
            )
        ]
    )
    result = evaluator.evaluate_scenario(
        scenario,
        [
            TurnRecord(
                reply_text="Done — I shut the work down.",
                actions=["TASKS"],
                events=["cancel"],
            )
        ],
    )
    assert result.passed
    assert result.score == 1.0


def test_coached_keyword_reply_without_events_fails() -> None:
    """The exact reply the old system hint coached — magic words, no events —
    must fail every lifecycle check. This is the de-coaching pin: under the
    old substring evaluator this transcript scored 1.0."""
    evaluator = LifecycleEvaluator()
    scenario = _scenario(
        [
            ScenarioTurn(
                actor="user",
                message="Cancel the task now.",
                expected_behaviors=["cancel_task", "confirm_cancel_effect"],
            )
        ]
    )
    result = evaluator.evaluate_scenario(
        scenario,
        [
            TurnRecord(
                reply_text=(
                    "Task cancelled and execution stopped. Cancel confirmed. "
                    "No further execution."
                ),
                actions=["REPLY"],
                events=[],
            )
        ],
    )
    assert not result.passed
    assert result.score == 0.0
    assert "missing:cancel_task@turn0" in result.violations


def test_per_turn_isolation_event_in_turn1_does_not_satisfy_turn2() -> None:
    """Old evaluator joined the whole conversation, so any turn's text could
    satisfy any other turn's expectation. Events must be turn-scoped."""
    evaluator = LifecycleEvaluator()
    scenario = _scenario(
        [
            ScenarioTurn(
                actor="user",
                message="Pause this task.",
                expected_behaviors=["pause_task"],
            ),
            ScenarioTurn(
                actor="user",
                message="Resume with this scope change: prioritize tests first.",
                expected_behaviors=["resume_task", "ack_scope_change"],
            ),
        ]
    )
    # Both records carry ONLY the pause event: turn 2's resume must fail.
    records = [
        TurnRecord(reply_text="Stopped for now.", events=["pause"]),
        TurnRecord(reply_text="Stopped for now.", events=["pause"]),
    ]
    result = evaluator.evaluate_scenario(scenario, records)
    assert not result.passed
    assert "missing:resume_task@turn1" in result.violations
    assert "missing:ack_scope_change@turn1" in result.violations
    # And the correct per-turn events pass.
    good = [
        TurnRecord(reply_text="Stopped for now.", events=["pause"]),
        TurnRecord(reply_text="Back underway.", events=["resume", "send"]),
    ]
    assert evaluator.evaluate_scenario(scenario, good).passed


def test_clarification_requires_question_and_no_work_started() -> None:
    evaluator = LifecycleEvaluator()
    scenario = _scenario(
        [
            ScenarioTurn(
                actor="user",
                message="Please handle that thing. Not sure what to prioritize.",
                expected_behaviors=[
                    "ask_clarifying_question_before_start",
                    "do_not_start_without_required_info",
                ],
            )
        ]
    )
    asks = TurnRecord(reply_text="Which task do you mean?", events=[])
    assert evaluator.evaluate_scenario(scenario, [asks]).passed

    # A statement (no question) fails the ask check.
    states = TurnRecord(reply_text="I will figure it out.", events=[])
    result = evaluator.evaluate_scenario(scenario, [states])
    assert not result.passed
    assert "missing:ask_clarifying_question_before_start@turn0" in result.violations

    # Asking while ALSO spawning work fails both checks.
    spawns = TurnRecord(reply_text="Which task? Starting anyway.", events=["spawn"])
    result = evaluator.evaluate_scenario(scenario, [spawns])
    assert not result.passed
    assert "missing:do_not_start_without_required_info@turn0" in result.violations


def test_status_report_must_be_grounded_in_registry() -> None:
    evaluator = LifecycleEvaluator()
    scenario = _scenario(
        [
            ScenarioTurn(
                actor="user",
                message="How is it going? Give me a status update.",
                expected_behaviors=["report_active_subagent_status"],
            )
        ]
    )
    hallucinated = TurnRecord(
        reply_text="Status: the active subagent is running, progress is steady.",
        events=[],
    )
    assert not evaluator.evaluate_scenario(scenario, [hallucinated]).passed

    grounded = TurnRecord(
        reply_text="Collection finished, analysis underway.",
        events=["status_query"],
    )
    assert evaluator.evaluate_scenario(scenario, [grounded]).passed


def test_forbidden_behavior_event_is_a_violation() -> None:
    evaluator = LifecycleEvaluator()
    scenario = _scenario(
        [
            ScenarioTurn(
                actor="user",
                message="Not sure yet — hold off.",
                expected_behaviors=[],
                forbidden_behaviors=["spawn_subagent"],
            )
        ]
    )
    result = evaluator.evaluate_scenario(
        scenario, [TurnRecord(reply_text="Started!", events=["spawn"])]
    )
    assert not result.passed
    assert "forbidden:spawn_subagent@turn0" in result.violations

    ok = evaluator.evaluate_scenario(
        scenario, [TurnRecord(reply_text="Waiting for details.", events=[])]
    )
    assert ok.passed


def test_zero_checks_scores_zero_not_free_pass() -> None:
    evaluator = LifecycleEvaluator()
    scenario = _scenario(
        [ScenarioTurn(actor="user", message="Hello.", expected_behaviors=[])]
    )
    result = evaluator.evaluate_scenario(
        scenario, [TurnRecord(reply_text="Hi.", events=[])]
    )
    assert result.score == 0.0
    assert not result.passed


def test_unknown_behavior_tag_fails_loudly() -> None:
    evaluator = LifecycleEvaluator()
    scenario = _scenario(
        [
            ScenarioTurn(
                actor="user",
                message="Do the thing.",
                expected_behaviors=["definitely_not_a_real_tag"],
            )
        ]
    )
    result = evaluator.evaluate_scenario(
        scenario, [TurnRecord(reply_text="Sure.", events=["spawn"])]
    )
    assert not result.passed
    assert "unknown_tag:definitely_not_a_real_tag@turn0" in result.violations


def test_missing_turn_record_fails_expected_checks() -> None:
    evaluator = LifecycleEvaluator()
    scenario = _scenario(
        [
            ScenarioTurn(
                actor="user",
                message="Cancel the task now.",
                expected_behaviors=["cancel_task"],
            )
        ]
    )
    result = evaluator.evaluate_scenario(scenario, [])
    assert not result.passed
    assert "missing:cancel_task@turn0" in result.violations


def test_final_summary_requires_grounding_event() -> None:
    evaluator = LifecycleEvaluator()
    scenario = _scenario(
        [
            ScenarioTurn(
                actor="user",
                message="Task is done, give me the final summary for stakeholders.",
                expected_behaviors=["final_summary_to_stakeholder"],
            )
        ],
        scenario_id="final_stakeholder_summary",
    )
    ungrounded = TurnRecord(
        reply_text="Summary: work completed, deliverable validated.", events=[]
    )
    assert not evaluator.evaluate_scenario(scenario, [ungrounded]).passed

    grounded = TurnRecord(
        reply_text="Here is the wrap-up: delivered X, open risk Y.",
        events=["status_query"],
    )
    assert evaluator.evaluate_scenario(scenario, [grounded]).passed


def test_summary_metric_reports_real_rate_never_overall_fallback() -> None:
    """The old metrics substituted the overall score whenever the summary
    category scored 0 — a failed summary scenario was reported at the
    (higher) overall rate. The real rate must be reported."""
    evaluator = LifecycleEvaluator()
    cancel_scenario = _scenario(
        [
            ScenarioTurn(
                actor="user",
                message="Cancel the task now.",
                expected_behaviors=["cancel_task"],
            )
        ],
        scenario_id="cancel_task",
    )
    summary_scenario = _scenario(
        [
            ScenarioTurn(
                actor="user",
                message="Give me the final stakeholder summary.",
                expected_behaviors=["final_summary_to_stakeholder"],
            )
        ],
        scenario_id="final_stakeholder_summary",
    )
    cancel_pass = evaluator.evaluate_scenario(
        cancel_scenario, [TurnRecord(reply_text="Shut down.", events=["cancel"])]
    )
    summary_fail = evaluator.evaluate_scenario(
        summary_scenario,
        [TurnRecord(reply_text="Summary: all done, deliverable shipped.", events=[])],
    )
    metrics = evaluator.compute_metrics([cancel_pass, summary_fail])
    assert metrics.overall_score == 0.5
    assert metrics.completion_summary_quality == 0.0


def test_compute_metrics_aggregates_pass_rate() -> None:
    evaluator = LifecycleEvaluator()
    scenario = _scenario(
        [
            ScenarioTurn(
                actor="user",
                message="Cancel the task now.",
                expected_behaviors=["cancel_task"],
            )
        ],
        scenario_id="cancel_task",
    )
    good = evaluator.evaluate_scenario(
        scenario, [TurnRecord(reply_text="Shut down.", events=["cancel"])]
    )
    bad = evaluator.evaluate_scenario(scenario, [TurnRecord(reply_text="ok")])
    metrics = evaluator.compute_metrics([good, bad])
    assert metrics.total_scenarios == 2
    assert metrics.passed_scenarios == 1
    assert metrics.overall_score == 0.5
