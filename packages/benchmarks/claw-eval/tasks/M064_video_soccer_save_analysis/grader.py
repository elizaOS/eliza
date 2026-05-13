"""M064_video_soccer_save_analysis grader — soccer save identification and timestamp."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class VideoSoccerSaveAnalysisGrader(AbstractGrader, MultimodalGraderMixin):
    """Grade soccer save analysis: team (0.5) + timestamp (0.5)."""

    RUBRIC = """\
Ground Truth (2 items):

1. Which team's goalkeeper made the first save (0.5): Real Madrid.
   - Correct (Real Madrid): 0.5
   - Wrong: 0.0

2. Timestamp of the save in the video, first occurrence (0.5): 1:05 \
(1 minute 5 seconds).
   - Within ±2 seconds (1:03 to 1:07): 0.5
   - Within ±5 seconds (1:00 to 1:10): 0.3
   - Within ±10 seconds: 0.1
   - Beyond: 0.0

Final score = sum of both items (0.0-1.0)."""

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
