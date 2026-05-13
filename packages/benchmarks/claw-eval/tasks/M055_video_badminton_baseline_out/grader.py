"""M055_video_badminton_baseline_out grader — badminton baseline out analysis."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class VideoBadmintonBaselineOutGrader(AbstractGrader, MultimodalGraderMixin):
    """Grade badminton baseline out analysis: count (0.4) + score list (0.6)."""

    RUBRIC = """\
Ground Truth (2 items):

1. Total count of points ended by a shot going long past the baseline (0.4): 6 points.
   - Exact (6): 0.4
   - Off by 1 (5 or 7): 0.2
   - Beyond: 0.0

2. Scores before each of these points, with ANTONSEN first (0.6 total, 0.1 each):
   The correct sequence is: 0:0, 0:1, 2:1, 3:1, 3:2, 4:2.
   Award 0.1 for each correctly listed score. 0.1 point is deducted for each wrong score. The minimum for this item is 0.0.

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
