"""M035_video_tennis_exhibition_qa grader — Australian Open exhibition matches."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class VideoTennisExhibitionQAGrader(AbstractGrader, MultimodalGraderMixin):
    """Grade tennis exhibition QA: match count + 3 matches x 4 details each."""

    RUBRIC = """\
Ground Truth: 3 amateur vs professional matches.

1. Total match count (0.1): Must state exactly 3 matches. Score 0.1 if correct.

2. Match 1 — Jovic vs Medvedev (0.3):
   - Players: Jovic and Medvedev (0.075)
   - Amateur: Jovic is the amateur (0.075)
   - Server: Jovic served (0.075)
   - Winner: Medvedev wins (0.075)

3. Match 2 — Yarwood vs Kyrgios (0.3):
   - Players: Yarwood and Kyrgios (0.075)
   - Amateur: Yarwood is the amateur (0.075)
   - Server: Yarwood served (0.075)
   - Winner: Kyrgios wins (0.075)

4. Match 3 — Garland vs Smith (0.3):
   - Players: Garland and Smith (0.075)
   - Amateur: Smith is the amateur (0.075)
   - Server: Garland served (0.075)
   - Winner: Smith wins (0.075)

Final score = sum of all items (0.0-1.0).
Matches must be in chronological order as they appear in the video."""

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
