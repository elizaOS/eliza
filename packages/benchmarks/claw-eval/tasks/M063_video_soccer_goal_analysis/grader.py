"""M063_video_soccer_goal_analysis grader — soccer goal count and timestamps."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class VideoSoccerGoalAnalysisGrader(AbstractGrader, MultimodalGraderMixin):
    """Grade soccer goal analysis: total count (0.2) + each goal details (0.4 each)."""

    RUBRIC = """\
Ground Truth (3 items):

1. Total number of goals (0.2): 2 goals.
   - Exact (2): 0.2
   - Wrong: 0.0

2. Goal 1 (0.4): Portugal, at match time 36:02.
   Both country (Portugal) and time must be correct.
   Time tolerance: ±5 seconds (i.e., 35:57 to 36:07).
   - Country correct AND time within tolerance: 0.4
   - Only country correct: 0.1
   - Only time correct: 0.1
   - Both wrong: 0.0

3. Goal 2 (0.4): Portugal, at match time 58:30.
   Both country (Portugal) and time must be correct.
   Time tolerance: ±5 seconds (i.e., 58:25 to 58:35).
   - Country correct AND time within tolerance: 0.4
   - Only country correct: 0.1
   - Only time correct: 0.1
   - Both wrong: 0.0

Final score = sum of all items (0.0-1.0)."""

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

        final_text = self._get_final_assistant_text(messages)
        if not final_text.strip():
            scores.completion = 0.0
            scores.robustness = self.compute_robustness(dispatches)
            return scores

        if judge:
            result = judge.evaluate(
                task_prompt=task.prompt.text,
                conversation=final_text,
                actions_summary="",
                rubric=self.RUBRIC,
            )
            scores.completion = result.score if result else 0.0

        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
