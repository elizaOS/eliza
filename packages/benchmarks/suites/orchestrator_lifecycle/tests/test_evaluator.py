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
from benchmarks.orchestrator_lifecycle.types import (
    Scenario,
    ScenarioResult,
    ScenarioTurn,
    TurnRecord,
)


def _scenario(
    turns: list[ScenarioTurn],
    scenario_id: str = "case",
    category: str = "test",
) -> Scenario:
    return Scenario(
        scenario_id=scenario_id,
        title=scenario_id,
        category=category,
        turns=turns,
    )


def _result(
    scenario_id: str,
    category: str,
    score: float,
    passed: bool = True,
) -> ScenarioResult:
    return ScenarioResult(
        scenario_id=scenario_id,
        title=scenario_id,
        category=category,
        passed=passed,
        score=score,
        checks_passed=1 if passed else 0,
        checks_total=1,
    )


def _capture_params(*arguments: dict[str, object]) -> dict[str, object]:
    return {
        "lifecycle_results": [
            {
                "name": "TASKS",
                "arguments": item,
                "result": {
                    "captured": True,
                    "effect": "not_executed",
                    "sequence": sequence,
                    "tool": "TASKS",
                },
            }
            for sequence, item in enumerate(arguments)
        ]
    }


def test_cancel_event_and_nonempty_outcome_report_pass_cancel_checks() -> None:
    evaluator = LifecycleEvaluator()
    scenario = _scenario(
        [
            ScenarioTurn(
                actor="user",
                message="Cancel the task now.",
                expected_behaviors=["cancel_task", "report_cancel_outcome"],
            )
        ]
    )
    result = evaluator.evaluate_scenario(
        scenario,
        [
            TurnRecord(
                reply_text="I captured the request; no side effect was executed.",
                actions=["TASKS"],
                params=_capture_params({"action": "cancel"}),
                events=["cancel"],
            )
        ],
    )
    assert result.passed
    assert result.score == 1.0


def test_cancel_outcome_report_does_not_require_a_success_claim() -> None:
    evaluator = LifecycleEvaluator()
    scenario = _scenario(
        [
            ScenarioTurn(
                actor="user",
                message="Cancel the task now.",
                expected_behaviors=["cancel_task", "report_cancel_outcome"],
            )
        ]
    )

    result = evaluator.evaluate_scenario(
        scenario,
        [
            TurnRecord(
                reply_text="I requested cancellation, but no matching task was found.",
                actions=["TASKS"],
                params=_capture_params({"action": "cancel"}),
                events=["cancel"],
            )
        ],
    )

    assert result.passed
    assert result.score == 1.0


def test_cancel_outcome_requires_exact_shared_capture_result() -> None:
    evaluator = LifecycleEvaluator()
    scenario = _scenario(
        [
            ScenarioTurn(
                actor="user",
                message="Cancel the task now.",
                expected_behaviors=["cancel_task", "report_cancel_outcome"],
            )
        ]
    )

    missing = evaluator.evaluate_scenario(
        scenario,
        [TurnRecord(reply_text="I cancelled it.", events=["cancel"])],
    )
    spoofed = evaluator.evaluate_scenario(
        scenario,
        [
            TurnRecord(
                reply_text="I cancelled it.",
                events=["cancel"],
                params={
                    "lifecycle_results": [
                        {
                            "name": "TASKS",
                            "arguments": {"action": "cancel"},
                            "result": {
                                "captured": True,
                                "effect": "executed",
                                "sequence": 0,
                                "tool": "TASKS",
                            },
                        }
                    ]
                },
            )
        ],
    )
    wrong_sequence = evaluator.evaluate_scenario(
        scenario,
        [
            TurnRecord(
                reply_text="I captured cancellation.",
                events=["cancel"],
                params={
                    "lifecycle_results": [
                        {
                            "name": "TASKS",
                            "arguments": {"action": "cancel"},
                            "result": {
                                "captured": True,
                                "effect": "not_executed",
                                "sequence": 1,
                                "tool": "TASKS",
                            },
                        }
                    ]
                },
            )
        ],
    )

    assert not missing.passed
    assert "missing:report_cancel_outcome@turn0" in missing.violations
    assert not spoofed.passed
    assert "missing:report_cancel_outcome@turn0" in spoofed.violations
    assert not wrong_sequence.passed
    assert "missing:cancel_task@turn0" in wrong_sequence.violations


def test_scenario_result_carries_category() -> None:
    evaluator = LifecycleEvaluator()
    scenario = _scenario(
        [
            ScenarioTurn(
                actor="user",
                message="How is it going?",
                expected_behaviors=["report_active_subagent_status"],
            )
        ],
        scenario_id="check_in_while_running",
        category="status",
    )
    result = evaluator.evaluate_scenario(
        scenario,
        [
            TurnRecord(
                reply_text="Still working.",
                params=_capture_params({"action": "list_agents"}),
                events=["status_query"],
            )
        ],
    )
    assert result.category == "status"


def test_category_metrics_do_not_depend_on_scenario_id_spelling() -> None:
    evaluator = LifecycleEvaluator()
    results = [
        _result("ambiguous_first_turn", "clarification", 0.25),
        _result("check_in_while_running", "status", 0.5),
        _result("cancel_task", "interrupt", 0.75),
        _result("final_stakeholder_summary", "completion_summary", 1.0),
    ]
    metrics = evaluator.compute_metrics(results)
    assert metrics.clarification_success_rate == 0.25
    assert metrics.status_accuracy_rate == 0.5
    assert metrics.interruption_handling_rate == 0.75
    assert metrics.completion_summary_quality == 1.0


def test_category_metrics_ignore_misleading_id_substrings() -> None:
    evaluator = LifecycleEvaluator()
    results = [
        _result("status_in_name_but_summary_category", "completion_summary", 0.2),
        _result("summary_in_name_but_status_category", "status", 0.8),
        _result("pause_in_name_but_scope_category", "scope", 1.0),
    ]
    metrics = evaluator.compute_metrics(results)
    assert metrics.status_accuracy_rate == 0.8
    assert metrics.completion_summary_quality == 0.2
    assert metrics.interruption_handling_rate == 0.0


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
                expected_behaviors=["cancel_task", "report_cancel_outcome"],
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


def test_positive_lifecycle_checks_reject_raw_event_labels() -> None:
    evaluator = LifecycleEvaluator()
    cases = (
        ("spawn_subagent", "spawn"),
        ("report_active_subagent_status", "status_query"),
        ("ack_scope_change", "send"),
        ("apply_scope_change_to_task", "send"),
        ("pause_task", "pause"),
        ("resume_task", "resume"),
        ("cancel_task", "cancel"),
        ("report_cancel_outcome", "cancel"),
        ("final_summary_to_stakeholder", "share"),
    )
    for behavior, event in cases:
        scenario = _scenario(
            [
                ScenarioTurn(
                    actor="user",
                    message="Exercise one lifecycle behavior.",
                    expected_behaviors=[behavior],
                )
            ]
        )
        record = TurnRecord(reply_text="Done.", actions=["TASKS"], events=[event])

        result = evaluator.evaluate_scenario(scenario, [record])

        assert result.score == 0.0, behavior
        assert f"missing:{behavior}@turn0" in result.violations


def test_spawn_requires_exact_action_and_nonempty_task_capture() -> None:
    evaluator = LifecycleEvaluator()
    scenario = _scenario(
        [
            ScenarioTurn(
                actor="user",
                message="Delegate this work.",
                expected_behaviors=["spawn_subagent"],
            )
        ]
    )
    missing_task = TurnRecord(
        params=_capture_params({"action": "spawn_agent", "task": "  "}),
        events=["spawn"],
    )
    wrong_action = TurnRecord(
        params=_capture_params({"action": "list_agents", "task": "Do work"}),
        events=["spawn"],
    )
    valid = TurnRecord(
        params=_capture_params({"action": "create", "task": "Do work"}),
        events=["spawn"],
    )

    assert not evaluator.evaluate_scenario(scenario, [missing_task]).passed
    assert not evaluator.evaluate_scenario(scenario, [wrong_action]).passed
    assert evaluator.evaluate_scenario(scenario, [valid]).passed


def test_scope_change_requires_nonempty_update_capture() -> None:
    evaluator = LifecycleEvaluator()
    scenario = _scenario(
        [
            ScenarioTurn(
                actor="user",
                message="Change scope: prioritize tests.",
                expected_behaviors=[
                    "ack_scope_change",
                    "apply_scope_change_to_task",
                ],
            )
        ]
    )
    empty_send = TurnRecord(
        reply_text="Understood.",
        params=_capture_params({"action": "send", "input": "  "}),
        events=["send"],
    )
    empty_resume = TurnRecord(
        reply_text="Understood.",
        params=_capture_params({"action": "control", "controlAction": "resume"}),
        events=["resume"],
    )
    valid_send = TurnRecord(
        reply_text="Understood.",
        params=_capture_params({"action": "send", "input": "Prioritize tests first."}),
        events=["send"],
    )
    valid_resume = TurnRecord(
        reply_text="Understood.",
        params=_capture_params(
            {
                "action": "control",
                "controlAction": "resume",
                "instruction": "Prioritize tests first.",
            }
        ),
        events=["resume"],
    )
    valid_reopen = TurnRecord(
        reply_text="Understood.",
        params=_capture_params(
            {"action": "reopen", "instruction": "Prioritize tests first."}
        ),
        events=["resume"],
    )

    assert not evaluator.evaluate_scenario(scenario, [empty_send]).passed
    assert not evaluator.evaluate_scenario(scenario, [empty_resume]).passed
    assert evaluator.evaluate_scenario(scenario, [valid_send]).passed
    assert evaluator.evaluate_scenario(scenario, [valid_resume]).passed
    assert evaluator.evaluate_scenario(scenario, [valid_reopen]).passed


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
        TurnRecord(
            reply_text="Stopped for now.",
            params=_capture_params({"action": "control", "controlAction": "pause"}),
            events=["pause"],
        ),
        TurnRecord(
            reply_text="Back underway.",
            params=_capture_params(
                {"action": "control", "controlAction": "resume"},
                {"action": "send", "input": "Prioritize tests first."},
            ),
            events=["resume", "send"],
        ),
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
        params=_capture_params({"action": "list_agents"}),
        events=["status_query"],
    )
    assert evaluator.evaluate_scenario(scenario, [grounded]).passed

    delegated_only = TurnRecord(
        reply_text="I started a worker and will keep you posted.",
        events=["spawn"],
    )
    result = evaluator.evaluate_scenario(scenario, [delegated_only])
    assert not result.passed
    assert "missing:report_active_subagent_status@turn0" in result.violations

    shared_only = TurnRecord(
        reply_text="Here is an artifact from the task.",
        events=["share"],
    )
    result = evaluator.evaluate_scenario(scenario, [shared_only])
    assert not result.passed
    assert "missing:report_active_subagent_status@turn0" in result.violations


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
        params=_capture_params({"action": "share", "taskId": "task-1"}),
        events=["share"],
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
        category="completion_summary",
    )
    cancel_pass = evaluator.evaluate_scenario(
        cancel_scenario,
        [
            TurnRecord(
                reply_text="Cancellation captured.",
                params=_capture_params({"action": "cancel"}),
                events=["cancel"],
            )
        ],
    )
    summary_fail = evaluator.evaluate_scenario(
        summary_scenario,
        [TurnRecord(reply_text="Summary: all done, deliverable shipped.", events=[])],
    )
    metrics = evaluator.compute_metrics([cancel_pass, summary_fail])
    assert metrics.overall_score == 0.5
    assert metrics.completion_summary_quality == 0.0


def test_category_metrics_use_scenario_metadata_not_id_substrings() -> None:
    """`check_in_while_running` is a status scenario even though its ID lacks
    the word "status"; category metrics must follow the scenario metadata."""
    evaluator = LifecycleEvaluator()
    scenario = Scenario(
        scenario_id="check_in_while_running",
        title="Check In While Running",
        category="status",
        turns=[
            ScenarioTurn(
                actor="user",
                message="How is it going? Give me a status update.",
                expected_behaviors=["report_active_subagent_status"],
            )
        ],
    )
    result = evaluator.evaluate_scenario(
        scenario,
        [
            TurnRecord(
                reply_text="Collection finished, analysis underway.",
                params=_capture_params({"action": "list_agents"}),
                events=["status_query"],
            )
        ],
    )
    metrics = evaluator.compute_metrics([result])
    assert result.category == "status"
    assert metrics.status_accuracy_rate == 1.0


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
        scenario,
        [
            TurnRecord(
                reply_text="Cancellation captured.",
                params=_capture_params({"action": "cancel"}),
                events=["cancel"],
            )
        ],
    )
    bad = evaluator.evaluate_scenario(scenario, [TurnRecord(reply_text="ok")])
    metrics = evaluator.compute_metrics([good, bad])
    assert metrics.total_scenarios == 2
    assert metrics.passed_scenarios == 1
    assert metrics.overall_score == 0.5
