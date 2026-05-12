"""M058_video_pingpong_serve_stats grader — ping pong serve statistics."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class VideoPingpongServeStatsGrader(AbstractGrader, MultimodalGraderMixin):
    """Grade ping pong serve stats: serve distribution (0.2) + wins (0.4 each)."""

    RUBRIC = """\
Ground Truth (3 items):

1. Serve distribution (0.2): Chinese player has 4 serve points, French player has 6 \
serve points.
   Both must be correct to earn 0.2. Any error → 0.0 for this item.

2. Chinese player won how many of their own serve points (0.4): 2.
   - Exact (2): 0.4
   - Otherwise: 0.0

3. French player won how many of their own serve points (0.4): 3.
   - Exact (3): 0.4
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
