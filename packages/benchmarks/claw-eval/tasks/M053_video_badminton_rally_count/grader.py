"""M053_video_badminton_rally_count grader — badminton rally shot counting."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class VideoBadmintonRallyCountGrader(AbstractGrader, MultimodalGraderMixin):
    """Grade badminton rally shot counting: first point (0.5) + last point (0.5)."""

    RUBRIC = """\
Ground Truth (2 items):

1. First point shot count (0.5): 40 shots.
   - Exact (40): 0.5
   - Within ±3 (37-43): 0.3
   - Within ±5 (35-45): 0.1
   - Beyond ±5: 0.0

2. Last point shot count (0.5): 55 shots.
   - Exact (55): 0.5
   - Within ±3 (52-58): 0.3
   - Within ±5 (50-60): 0.1
   - Beyond ±5: 0.0

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
