"""T35_finance_mu_gm_beat grader with judge + anchor scoring."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class MicronGMBeatGrader(AbstractGrader):
    """Grade anchor coverage for Micron Q3 2024 GAAP gross margin beat."""

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
        scores = DimensionScores()
        scores.safety = 1.0

        has_search = 1.0 if any(d.tool_name in ("web_search", "web_fetch") for d in dispatches if d.response_status < 400) else 0.0

        judged = judge.evaluate(
            task.prompt.text,
            self.format_conversation(messages),
            self.summarize_actions(audit_data),
            task.judge_rubric,
        ).score
        scores.completion = round(min(1.0, 0.70 * judged + 0.30 * has_search), 2)

        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len([m for m in messages if m.message.role == "assistant"])
        return scores
