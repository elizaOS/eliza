"""M062_video_snooker_brown_ball_time grader — snooker brown ball timestamp."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class VideoSnookerBrownBallTimeGrader(AbstractGrader, MultimodalGraderMixin):
    """Grade snooker brown ball timestamps: first attempt (0.5) + potted (0.5)."""

    RUBRIC = """\
Ground Truth (2 items):

1. First attempt to pot the brown ball (0.5): 01:06 (1 minute 6 seconds).
   - Within ±3 seconds of 01:06 (i.e., 01:03 to 01:09): 0.5
   - Within ±5 seconds: 0.3
   - Within ±10 seconds: 0.1
   - Beyond: 0.0

2. Brown ball actually potted (0.5): 09:40 (9 minutes 40 seconds).
   - Within ±3 seconds of 09:40 (i.e., 09:37 to 09:43): 0.5
   - Within ±5 seconds: 0.3
   - Within ±10 seconds: 0.1
   - Beyond: 0.0

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
