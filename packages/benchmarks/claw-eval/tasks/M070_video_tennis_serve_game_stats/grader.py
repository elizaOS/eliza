"""M070_video_tennis_serve_game_stats grader — tennis serve game statistics."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class VideoTennisServeGameStatsGrader(AbstractGrader, MultimodalGraderMixin):
    """Grade tennis serve game stats: 4 items, 0.25 each."""

    RUBRIC = """\
Ground Truth (4 items, 0.25 each):

1. Zverev serve points shown in Set 1 (0.25): 4.
   - Exact (4): 0.25
   - Otherwise: 0.0

2. Sinner serve points shown in Set 1 (0.25): 5.
   - Exact (5): 0.25
   - Otherwise: 0.0

3. Zverev won how many of his own serve points (0.25): 2.
   - Exact (2): 0.25
   - Otherwise: 0.0

4. Sinner won how many of his own serve points (0.25): 2.
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
