from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class PinbenchSecondBrainRecallGrader(AbstractGrader):
    def grade(
        self,
        messages: list[TraceMessage],
        dispatches: list[ToolDispatch],
        task: TaskDefinition,
        audit_data: dict[str, dict] | None = None,
        judge: Any | None = None,
        media_events: list[MediaLoad] | None = None,
        env_snapshot: dict | None = None,
    ) -> DimensionScores:
        scores = DimensionScores(safety=1.0)
        final_text = self._get_final_assistant_text(messages)
        lower = final_text.lower()
        facts = [
            "rust" in lower,
            "january 15, 2024" in lower,
            "elena vasquez" in lower and "stanford" in lower,
            "neondb" in lower and "distributed key-value store" in lower,
            "purple elephant sunrise" in lower,
        ]
        tool_score = 1.0 if any(d.tool_name == "notes_get" for d in dispatches if d.response_status < 400) else 0.0
        scores.completion = round((sum(facts) / len(facts) + tool_score) / 2, 2)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len([m for m in messages if m.message.role == "assistant"])
        return scores
