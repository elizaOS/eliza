"""Structural evaluator for orchestrator lifecycle scenarios.

Scores each user turn against the typed lifecycle events the agent actually
emitted on THAT turn (see ``events.py``), not keyword substrings in its prose.
A reply that merely *talks about* cancelling/pausing/spawning — without the
corresponding typed event — fails the check. The only text-level facts used
are structural: whether the reply is non-empty, and whether it asks the user
a question (for the clarification tags).

Fail-loud rules:
  * a scenario with zero checks scores 0.0 (never a free 1.0),
  * an unknown behavior tag is a violation (scenario bug), never a silent pass,
  * a user turn with no captured record fails all of its expected checks.
"""

from __future__ import annotations

from .types import LifecycleMetrics, Scenario, ScenarioResult, TurnRecord

# Events that mean the agent started or advanced work on a task.
_WORK_STARTING_EVENTS = frozenset({"spawn", "send"})
# Events that apply new/changed direction to an in-flight task.
_SCOPE_APPLY_EVENTS = frozenset({"send", "spawn", "resume"})
# Events that ground a status report / summary in the real task registry.
_STATUS_GROUNDING_EVENTS = frozenset({"status_query", "spawn", "share"})
_SUMMARY_GROUNDING_EVENTS = frozenset({"status_query", "share"})


def _has_any(record: TurnRecord, events: frozenset[str]) -> bool:
    return any(event in events for event in record.events)


def _asks_question(record: TurnRecord) -> bool:
    return "?" in record.reply_text


def _replied(record: TurnRecord) -> bool:
    return bool(record.reply_text.strip())


def check_behavior(behavior: str, record: TurnRecord) -> bool | None:
    """Return True/False for a known behavior tag, None for an unknown tag."""
    if behavior == "ask_clarifying_question_before_start":
        return _asks_question(record) and not _has_any(record, _WORK_STARTING_EVENTS)
    if behavior == "do_not_start_without_required_info":
        return not _has_any(record, _WORK_STARTING_EVENTS)
    if behavior == "spawn_subagent":
        return "spawn" in record.events
    if behavior == "report_active_subagent_status":
        return _replied(record) and _has_any(record, _STATUS_GROUNDING_EVENTS)
    if behavior == "ack_scope_change":
        return _replied(record) and _has_any(record, _SCOPE_APPLY_EVENTS)
    if behavior == "apply_scope_change_to_task":
        return _has_any(record, _SCOPE_APPLY_EVENTS)
    if behavior == "pause_task":
        return "pause" in record.events
    if behavior == "resume_task":
        return "resume" in record.events
    if behavior == "cancel_task":
        return "cancel" in record.events
    if behavior == "confirm_cancel_effect":
        return "cancel" in record.events and _replied(record)
    if behavior == "final_summary_to_stakeholder":
        return _replied(record) and _has_any(record, _SUMMARY_GROUNDING_EVENTS)
    return None


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
                    check_behavior(behavior, record) if record is not None else False
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

        def _rate(tag: str) -> float:
            tagged = [r for r in results if tag in r.scenario_id]
            if not tagged:
                return 0.0
            return sum(r.score for r in tagged) / len(tagged)

        clarification = _rate("clarification")
        status = _rate("status")
        interruption = (
            _rate("pause")
            + _rate("resume")
            + _rate("cancel")
            + _rate("interrupt")
        ) / 4
        # No inflation fallback: a category with no scenarios (or all-failing
        # scenarios) reports its real rate, never the overall score.
        summary = _rate("summary")
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
