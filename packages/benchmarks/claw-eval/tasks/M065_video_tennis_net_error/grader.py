"""M065_video_tennis_net_error grader — tennis rally net error analysis."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class VideoTennisNetErrorGrader(AbstractGrader, MultimodalGraderMixin):
    """Grade tennis net error: count (0.4) + score and time details (0.3 each)."""

    RUBRIC = """\
Ground Truth (3 items):

1. Number of times Lehecka lost a point by hitting into the net during a rally (0.4): \
1 time.
   - Exact (1): 0.4
   - Wrong: 0.0

2. Score before that point, Lehecka first (0.3): Sets 0:0, Games 1:1, Points 15:30.
   All three scores (set score, game score, point score) must be correct.
   - All correct: 0.3
   - Otherwise: 0.0

3. Time when this point ended (0.3): 0:31 (31 seconds).
   - Within ±1 second (0:30 to 0:32): 0.3
   - Within ±3 seconds (0:28 to 0:34): 0.2
   - Within ±5 seconds: 0.1
   - Beyond: 0.0

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
