"""M057_video_pingpong_rally_count grader — ping pong rally shot count."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class VideoPingpongRallyCountGrader(AbstractGrader, MultimodalGraderMixin):
    """Grade ping pong rally: shot count (0.5) + server scored or not (0.5)."""

    RUBRIC = """\
Ground Truth (2 items):

1. Total shots in the first point (0.5): 21 shots.
   - Exact (21): 0.5
   - Within ±2 (19-23): 0.25
   - Beyond: 0.0

2. Did the server score? (0.5): No, the server lost the point.
   - Correct (server did not score / server lost): 0.5
   - Wrong: 0.0

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
