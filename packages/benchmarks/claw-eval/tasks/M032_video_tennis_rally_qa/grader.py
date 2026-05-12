"""M032_video_tennis_rally_qa grader — tennis rally analysis with shot counting."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class VideoTennisRallyQAGrader(AbstractGrader, MultimodalGraderMixin):
    """Grade tennis rally QA: items 1-5 (0.1 each) + shot count (0.5)."""

    RUBRIC = """\
Ground Truth (6 items):

1. Players (0.1): Djokovic vs Nadal. Both names must be correct.
2. Set (0.1): Second set. Must state "second set" or "2nd set".
3. Score before point (0.1): Game score 3:2, point score 40:30. \
Both game score and point score must be correct.
4. Score after point (0.1): Game score 4:2. Must be correct.
5. Point winner (0.1): Djokovic wins the point. Must name Djokovic.
6. Total shots in rally (0.5): 54 shots.
   - Exact (54): 0.5
   - Within ±3 (51-57): 0.4
   - Within ±5 (49-59): 0.3
   - Within ±10 (44-64): 0.2
   - Within ±15 (39-69): 0.1
   - Beyond ±15: 0.0

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
