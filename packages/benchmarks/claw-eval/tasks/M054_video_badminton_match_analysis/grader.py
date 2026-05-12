"""M054_video_badminton_match_analysis grader — badminton match serve and score analysis."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class VideoBadmintonMatchAnalysisGrader(AbstractGrader, MultimodalGraderMixin):
    """Grade badminton match analysis: total games + 3 point details."""

    RUBRIC = """\
Ground Truth (4 items):

1. Total games in the match (0.1): 3 games.
   Must state the match has 3 games total.

2. Game 2 Point 1 (0.3): Shi Yuqi serves, right half court, \
Axelsen scores.
   All three details must be correct to earn 0.3. Any error → 0.0 for this item.

3. Game 2 Point 10 (0.3): Shi Yuqi serves, left half court, \
Axelsen scores.
   All three details must be correct to earn 0.3. Any error → 0.0 for this item.

4. Game 2 Last Point (0.3): Axelsen serves, right half court, \
Axelsen scores.
   All three details must be correct to earn 0.3. Any error → 0.0 for this item.

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
