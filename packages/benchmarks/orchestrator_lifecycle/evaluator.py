"""Rule-based evaluator for orchestrator lifecycle scenarios."""

from __future__ import annotations

from .types import LifecycleMetrics, Scenario, ScenarioResult


BEHAVIOR_KEYWORDS: dict[str, list[str]] = {
    "ask_clarifying_question_before_start": ["clarify", "could you specify", "need more detail"],
    "do_not_start_without_required_info": ["will wait", "before starting", "need details first"],
    "spawn_subagent": ["subagent", "delegate", "worker"],
    "report_active_subagent_status": ["status", "progress", "active subagent"],
    "ack_scope_change": ["scope change", "updated scope", "changed request"],
    "apply_scope_change_to_task": ["updated plan", "re-planned", "new task plan"],
    "pause_task": ["paused", "on hold"],
    "resume_task": ["resumed", "continuing"],
    "cancel_task": ["cancelled", "stopped"],
    "confirm_cancel_effect": ["no further execution", "cancel confirmed", "won't continue"],
    "final_summary_to_stakeholder": ["summary", "completed", "deliverable"],
}


class LifecycleEvaluator:
    def evaluate_scenario(
        self,
        scenario: Scenario,
        assistant_messages: list[str],
    ) -> ScenarioResult:
        checks_total = 0
        checks_passed = 0
        violations: list[str] = []
        notes: list[str] = []

        combined = "\n".join(assistant_messages).lower()
        for turn in scenario.turns:
            for behavior in turn.expected_behaviors:
                checks_total += 1
                if self._has_behavior(combined, behavior):
                    checks_passed += 1
                else:
                    violations.append(f"missing:{behavior}")
            for behavior in turn.forbidden_behaviors:
                checks_total += 1
                if self._has_behavior(combined, behavior):
                    violations.append(f"forbidden:{behavior}")
                else:
                    checks_passed += 1

        score = (checks_passed / checks_total) if checks_total > 0 else 1.0
        passed = score >= 0.75 and not any(v.startswith("forbidden") for v in violations)
        if passed:
            notes.append("Scenario passed threshold checks.")
        else:
            notes.append("Scenario failed threshold checks.")
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
        summary = _rate("summary")
        if summary == 0:
            summary = overall
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

    def _has_behavior(self, combined_text: str, behavior: str) -> bool:
        keywords = BEHAVIOR_KEYWORDS.get(behavior, [])
        if not keywords:
            return behavior.replace("_", " ") in combined_text
        return any(keyword in combined_text for keyword in keywords)
