"""M067_video_tennis_long_rally grader — tennis long rally analysis."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class VideoTennisLongRallyGrader(AbstractGrader, MultimodalGraderMixin):
    """Grade tennis long rally: 5 items, 0.2 each."""

    RUBRIC = """\
Ground Truth (5 items, 0.2 each):

1. Start time of the rally (0.2): 00:20 (20 seconds).
   - Within ±2 seconds (00:18 to 00:22): 0.2
   - Within ±5 seconds: 0.1
   - Beyond: 0.0

2. Total shots in this rally (0.2): 10 shots.
   - Exact (10): 0.2
   - Otherwise: 0.0

3. Server (0.2): Gauff.
   - Correct: 0.2
   - Wrong: 0.0

4. Point winner (0.2): Sabalenka.
   - Correct: 0.2
   - Wrong: 0.0

5. How the point was won (0.2): Winner, not an error.
   - Correct (winner): 0.2
   - Wrong (error): 0.0

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
