"""M071_video_tennis_break_point_stats grader — tennis break point statistics."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class VideoTennisBreakPointStatsGrader(AbstractGrader, MultimodalGraderMixin):
    """Grade tennis break point stats: 4 items, 0.25 each."""

    RUBRIC = """\
Ground Truth (4 items, 0.25 each):

1. Alcaraz break points faced (0.25): 2.
   - Exact (2): 0.25
   - Otherwise: 0.0

2. Alcaraz break points saved (0.25): 0.
   - Exact (0): 0.25
   - Otherwise: 0.0

3. Medvedev break points faced (0.25): 3.
   - Exact (3): 0.25
   - Otherwise: 0.0

4. Medvedev break points saved (0.25): 2.
   - Exact (2): 0.25
   - Otherwise: 0.0

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
