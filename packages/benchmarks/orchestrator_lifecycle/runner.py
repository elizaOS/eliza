"""Runner for orchestrator lifecycle benchmark scenarios."""

from __future__ import annotations

import random

from .dataset import LifecycleDataset
from .evaluator import LifecycleEvaluator
from .reporting import save_report
from .types import LifecycleConfig, LifecycleMetrics, ScenarioResult


class LifecycleRunner:
    def __init__(self, config: LifecycleConfig) -> None:
        self.config = config
        self.dataset = LifecycleDataset(config.scenario_dir)
        self.evaluator = LifecycleEvaluator()
        self._rng = random.Random(config.seed)

    def run(self) -> tuple[list[ScenarioResult], LifecycleMetrics, str]:
        scenarios = self.dataset.load()
        if self.config.scenario_filter:
            token = self.config.scenario_filter.lower()
            scenarios = [
                scenario
                for scenario in scenarios
                if token in scenario.scenario_id.lower() or token in scenario.title.lower()
            ]
        if self.config.max_scenarios is not None:
            scenarios = scenarios[: self.config.max_scenarios]

        results: list[ScenarioResult] = []
        transcripts: dict[str, list[dict[str, str]]] = {}
        for scenario in scenarios:
            conversation: list[dict[str, str]] = []
            assistant_messages: list[str] = []
            for turn in scenario.turns:
                conversation.append({"actor": turn.actor, "message": turn.message})
                if turn.actor != "user":
                    continue
                reply = self._simulate_reply(turn.message)
                assistant_messages.append(reply)
                conversation.append({"actor": "assistant", "message": reply})
            result = self.evaluator.evaluate_scenario(scenario, assistant_messages)
            results.append(result)
            transcripts[scenario.scenario_id] = conversation

        metrics = self.evaluator.compute_metrics(results)
        report_path = save_report(
            config=self.config,
            results=results,
            metrics=metrics,
            transcripts=transcripts,
        )
        return results, metrics, str(report_path)

    def _simulate_reply(self, message: str) -> str:
        msg = message.lower()
        if any(token in msg for token in ["not sure", "unspecified", "unclear"]):
            return (
                "I need more detail before starting. Could you clarify scope, "
                "acceptance criteria, and constraints?"
            )
        if "status" in msg or "how is it going" in msg or "check in" in msg:
            return (
                "Status: active subagent is running, progress is steady, no blockers, "
                "next step is validation."
            )
        if "pause" in msg:
            return "Task paused and put on hold. No further execution until resume."
        if "resume" in msg:
            return "Task resumed and continuing with the updated requirements."
        if "cancel" in msg and "undo" not in msg:
            return "Task cancelled and execution stopped. Cancel confirmed."
        if "undo" in msg or "uncancel" in msg:
            return "Cancellation undone, updated plan applied, and task resumed."
        if "change" in msg or "scope" in msg:
            return (
                "Scope change acknowledged. I updated the plan, delegated to the right "
                "subagent, and will report progress."
            )
        if "summary" in msg or "done" in msg or "complete" in msg:
            return (
                "Summary: work completed, deliverable validated, risks noted, and next "
                "actions documented for stakeholder review."
            )
        generic = [
            "I will delegate this to a subagent and provide regular status updates.",
            "I created a task plan and started execution with progress tracking.",
            "I will report blockers, failures, and next actions as they occur.",
        ]
        return generic[self._rng.randrange(len(generic))]
