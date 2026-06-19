"""M072_video_tennis_set_end_time grader — tennis set end timestamps and winner."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class VideoTennisSetEndTimeGrader(AbstractGrader, MultimodalGraderMixin):
    """Grade tennis set end timestamps + winner: 4 items, 0.25 each."""

    RUBRIC = """\
Ground Truth (4 items, 0.25 each):

1. Set 1 last point end time (0.25): 1:02 (1 minute 2 seconds).
   - Within ±2 seconds (1:00 to 1:04): 0.25
   - Within ±5 seconds (0:57 to 1:07): 0.1
   - Otherwise: 0.0

2. Set 2 last point end time (0.25): 2:00 (2 minutes 0 seconds).
   - Within ±2 seconds (1:58 to 2:02): 0.25
   - Within ±5 seconds (1:55 to 2:05): 0.1
   - Otherwise: 0.0

3. Set 3 last point end time (0.25): 4:29 (4 minutes 29 seconds).
   - Within ±2 seconds (4:27 to 4:31): 0.25
   - Within ±5 seconds (4:24 to 4:34): 0.1
   - Otherwise: 0.0

4. Match winner (0.25): ELENA RYBAKINA.
   - Correct (Rybakina / Elena Rybakina): 0.25
   - Wrong: 0.0

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
