"""M060_video_pingpong_let_serve grader — ping pong let serve count."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class VideoPingpongLetServeGrader(AbstractGrader, MultimodalGraderMixin):
    """Grade ping pong let serve: count (0.4) + scores (0.2 each)."""

    RUBRIC = """\
Ground Truth (2 items):

1. Total number of let serves (0.4): 3 times.
   - Exact (3): 0.4
   - Off by 1 (2 or 4): 0.2
   - Beyond: 0.0

2. Scores at each let serve, Brazilian player first (0.6 total, 0.2 each):
   - 3:1 (0.2)
   - 3:1 (0.2)
   - 10:5 (0.2)
   Award 0.2 for each correctly identified score. 0.2 point is deducted for each wrong score. The minimum for this item is 0.0.

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
