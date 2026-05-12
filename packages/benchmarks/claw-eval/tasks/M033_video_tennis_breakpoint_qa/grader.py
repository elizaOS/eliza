"""M033_video_tennis_breakpoint_qa grader — Djokovic break point analysis."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class VideoTennisBreakpointQAGrader(AbstractGrader, MultimodalGraderMixin):
    """Grade Djokovic break point analysis: count(0.2) + 2 break points(0.8)."""

    RUBRIC = """\
Ground Truth:

Djokovic saved 2 break points in the fifth set in this video.

Break Point 1:
- Game score: 1:2, Point score: 15:40
- Video timestamp: approximately 2:23
- Resolution: Djokovic's winner

Break Point 2:
- Game score: 4:3, Point score: 15:40
- Video timestamp: approximately 2:36
- Resolution: Djokovic's winner

Scoring:
1. Total break point count (0.2): Must state exactly 2. Score 0.2 if correct, 0 otherwise.

2. Break Point 1 details (0.4):
   - Game score correct "1:2" (0.1)
   - Point score correct "15:40" (0.1)
   - Timestamp approximately correct within ±5s of 2:23 (0.1)
   - Resolution correct "Djokovic's winner" (0.1)

3. Break Point 2 details (0.4):
   - Game score correct "4:3" (0.1)
   - Point score correct "15:40" (0.1)
   - Timestamp approximately correct within ±5s of 2:36 (0.1)
   - Resolution correct "Djokovic's winner" (0.1)

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
