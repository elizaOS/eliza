"""M066_video_tennis_lob_winner grader — tennis defensive lob winner analysis."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class VideoTennisLobWinnerGrader(AbstractGrader, MultimodalGraderMixin):
    """Grade tennis lob winner: count (0.2) + details (0.8 total, 0.2 each)."""

    RUBRIC = """\
Ground Truth (5 items):

1. Number of defensive lob winners (0.2): 1 time.
   - Exact (1): 0.2
   - Wrong: 0.0

2. Scoring player (0.2): Alcaraz.
   - Correct: 0.2
   - Wrong: 0.0

3. Opponent player (0.2): Korda.
   - Correct: 0.2
   - Wrong: 0.0

4. Server of this point (0.2): Alcaraz.
   - Correct: 0.2
   - Wrong: 0.0

5. Total shots in this point (0.2): 5 shots.
   - Exact (5): 0.2
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
