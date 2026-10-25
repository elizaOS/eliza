"""Structural evaluator for orchestrator lifecycle scenarios.

Scores each user turn against the exact shared capture-only ``TASKS`` result
the agent emitted on THAT turn, not keyword substrings or raw action labels.
The only text-level facts used are structural: whether the reply is non-empty,
and whether it asks the user a question (for the clarification tags).

Fail-loud rules:
  * a scenario with zero checks scores 0.0 (never a free 1.0),
  * an unknown behavior tag is a violation (scenario bug), never a silent pass,
  * a user turn with no captured record fails all of its expected checks.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence

from .types import LifecycleMetrics, Scenario, ScenarioResult, TurnRecord

# Events that mean the agent started or advanced work on a task.
_WORK_STARTING_EVENTS = frozenset({"spawn", "send"})
# Events that show the agent requested task status before reporting it.
_STATUS_GROUNDING_EVENTS = frozenset({"status_query"})
_SUMMARY_GROUNDING_EVENTS = frozenset({"status_query", "share"})


def _has_any(record: TurnRecord, events: frozenset[str]) -> bool:
    return any(event in events for event in record.events)


def _asks_question(record: TurnRecord) -> bool:
    return "?" in record.reply_text


def _replied(record: TurnRecord) -> bool:
    return bool(record.reply_text.strip())


def _captured_arguments_event(arguments: Mapping[str, object]) -> str | None:
    action = arguments.get("action")
    if not isinstance(action, str):
        return None
    normalized = action.strip().lower()
    direct_events = {
        "create": "spawn",
        "spawn_agent": "spawn",
        "send": "send",
        "stop_agent": "cancel",
        "list_agents": "status_query",
        "cancel": "cancel",
        "history": "status_query",
        "share": "share",
        "reopen": "resume",
    }
    if normalized != "control":
        return direct_events.get(normalized)
    control_action = arguments.get("controlAction")
    if not isinstance(control_action, str):
        return None
    return {
        "pause": "pause",
        "resume": "resume",
        "continue": "resume",
        "stop": "cancel",
        "reopen": "resume",
    }.get(control_action.strip().lower())


def _capture_only_arguments(
    record: TurnRecord, event: str
) -> list[Mapping[str, object]]:
    raw_results = record.params.get("lifecycle_results")
    if not isinstance(raw_results, Sequence) or isinstance(
        raw_results, (str, bytes, bytearray)
    ):
        return []
    matches: list[Mapping[str, object]] = []
    for expected_sequence, raw in enumerate(raw_results):
        if (
            not isinstance(raw, Mapping)
            or set(raw) != {"name", "arguments", "result"}
            or raw.get("name") != "TASKS"
        ):
            continue
        arguments = raw.get("arguments")
        result = raw.get("result")
        if not isinstance(arguments, Mapping) or not isinstance(result, Mapping):
            continue
        sequence = result.get("sequence")
        if (
            set(result) != {"captured", "effect", "sequence", "tool"}
            or result.get("captured") is not True
            or result.get("effect") != "not_executed"
            or result.get("tool") != "TASKS"
            or not isinstance(sequence, int)
            or isinstance(sequence, bool)
            or sequence != expected_sequence
        ):
            continue
        if _captured_arguments_event(arguments) == event:
            matches.append(arguments)
    return matches


def _has_capture_only_result(record: TurnRecord, event: str) -> bool:
    return bool(_capture_only_arguments(record, event))


def _has_any_capture_only_result(record: TurnRecord, events: frozenset[str]) -> bool:
    return any(_has_capture_only_result(record, event) for event in events)


def _has_spawn_capture(record: TurnRecord) -> bool:
    for arguments in _capture_only_arguments(record, "spawn"):
        action = arguments.get("action")
        task = arguments.get("task")
        if (
            isinstance(action, str)
            and action.strip().lower() in {"create", "spawn_agent"}
            and isinstance(task, str)
            and bool(task.strip())
        ):
            return True
    return False


def _has_scope_update_capture(record: TurnRecord) -> bool:
    for arguments in _capture_only_arguments(record, "send"):
        update = arguments.get("input")
        if isinstance(update, str) and update.strip():
            return True
    for arguments in _capture_only_arguments(record, "resume"):
        update = arguments.get("instruction")
        if isinstance(update, str) and update.strip():
            return True
    return False


def check_behavior(behavior: str, record: TurnRecord) -> bool | None:
    """Return True/False for a known behavior tag, None for an unknown tag."""
    if behavior == "ask_clarifying_question_before_start":
        return _asks_question(record) and not _has_any(record, _WORK_STARTING_EVENTS)
    if behavior == "do_not_start_without_required_info":
        return not _has_any(record, _WORK_STARTING_EVENTS)
    if behavior == "spawn_subagent":
        return _has_spawn_capture(record)
    if behavior == "report_active_subagent_status":
        return _replied(record) and _has_any_capture_only_result(
            record, _STATUS_GROUNDING_EVENTS
        )
    if behavior == "ack_scope_change":
        return _replied(record) and _has_scope_update_capture(record)
    if behavior == "apply_scope_change_to_task":
        return _has_scope_update_capture(record)
    if behavior == "pause_task":
        return _has_capture_only_result(record, "pause")
    if behavior == "resume_task":
        return _has_capture_only_result(record, "resume")
    if behavior == "cancel_task":
        return _has_capture_only_result(record, "cancel")
    if behavior == "report_cancel_outcome":
        # The benchmark cannot grade arbitrary prose semantics without adding
        # a model judge. It can prove that the reply followed the exact shared
        # capture-only cancellation result, rather than an action label alone.
        return _replied(record) and _has_capture_only_result(record, "cancel")
    if behavior == "final_summary_to_stakeholder":
        return _replied(record) and _has_any_capture_only_result(
            record, _SUMMARY_GROUNDING_EVENTS
        )
    return None


def _forbidden_behavior_observed(behavior: str, record: TurnRecord) -> bool | None:
    if behavior == "spawn_subagent":
        return "spawn" in record.events
    return check_behavior(behavior, record)


class LifecycleEvaluator:
    def evaluate_scenario(
        self,
        scenario: Scenario,
        turn_records: list[TurnRecord],
    ) -> ScenarioResult:
        checks_total = 0
        checks_passed = 0
        violations: list[str] = []
        notes: list[str] = []

        user_turns = [turn for turn in scenario.turns if turn.actor == "user"]
        for turn_idx, turn in enumerate(user_turns):
            record = turn_records[turn_idx] if turn_idx < len(turn_records) else None
            if record is None:
                notes.append(f"turn {turn_idx}: no agent record captured")
            for behavior in turn.expected_behaviors:
                checks_total += 1
                outcome = (
                    check_behavior(behavior, record) if record is not None else False
                )
                if outcome is None:
                    violations.append(f"unknown_tag:{behavior}@turn{turn_idx}")
                elif outcome:
                    checks_passed += 1
                else:
                    violations.append(f"missing:{behavior}@turn{turn_idx}")
            for behavior in turn.forbidden_behaviors:
                checks_total += 1
                outcome = (
                    _forbidden_behavior_observed(behavior, record)
                    if record is not None
                    else False
                )
                if outcome is None:
                    violations.append(f"unknown_tag:{behavior}@turn{turn_idx}")
                elif outcome:
                    violations.append(f"forbidden:{behavior}@turn{turn_idx}")
                else:
                    checks_passed += 1

        # No checks means the scenario cannot demonstrate anything — that is a
        # scenario bug and must fail loudly, never score a free 1.0.
        score = (checks_passed / checks_total) if checks_total > 0 else 0.0
        if checks_total == 0:
            notes.append("Scenario defines no checks — scored 0.")
        passed = (
            checks_total > 0
            and score >= 0.75
            and not any(
                v.startswith("forbidden") or v.startswith("unknown_tag")
                for v in violations
            )
        )
        notes.append(
            "Scenario passed threshold checks."
            if passed
            else "Scenario failed threshold checks."
        )
        return ScenarioResult(
            scenario_id=scenario.scenario_id,
            title=scenario.title,
            category=scenario.category,
            passed=passed,
            score=score,
            checks_passed=checks_passed,
            checks_total=checks_total,
            violations=violations,
            notes=notes,
        )

    def compute_metrics(self, results: list[ScenarioResult]) -> LifecycleMetrics:
        total = len(results)
        passed = sum(1 for r in results if r.passed)
        overall = (sum(r.score for r in results) / total) if total > 0 else 0.0

        def _category_rate(category: str) -> float:
            tagged = [r for r in results if r.category == category]
            if not tagged:
                return 0.0
            return sum(r.score for r in tagged) / len(tagged)

        clarification = _category_rate("clarification")
        status = _category_rate("status")
        interruption = _category_rate("interrupt")
        # No inflation fallback: a category with no scenarios (or all-failing
        # scenarios) reports its real rate, never the overall score.
        summary = _category_rate("completion_summary")
        return LifecycleMetrics(
            overall_score=overall,
            scenario_pass_rate=(passed / total) if total > 0 else 0.0,
            total_scenarios=total,
            passed_scenarios=passed,
            clarification_success_rate=clarification,
            status_accuracy_rate=status,
            interruption_handling_rate=interruption,
            completion_summary_quality=summary,
        )
