from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class PinbenchProjectBootstrapPlanGrader(AbstractGrader):
    EXPECTED = ["src/datautils", "tests", "pyproject", "README"]

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
        create_calls = [d for d in dispatches if d.tool_name == "todo_create_task" and d.response_status < 400]
        titles = " ".join(str(d.request_body.get("title", "")) for d in create_calls)
        hit_ratio = sum(1 for item in self.EXPECTED if item.lower() in titles.lower()) / len(self.EXPECTED)
        summary_ratio = sum(1 for item in self.EXPECTED if item.lower() in final_text.lower()) / len(self.EXPECTED)
        scores.completion = round((min(len(create_calls) / 4, 1.0) + hit_ratio + summary_ratio) / 3, 2)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len([m for m in messages if m.message.role == "assistant"])
        return scores
