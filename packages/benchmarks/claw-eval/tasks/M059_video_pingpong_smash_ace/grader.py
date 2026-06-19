"""T146_video_pingpong_smash_ace grader — ping pong smash ace count."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class VideoPingpongSmashAceGrader(AbstractGrader, MultimodalGraderMixin):
    """Grade ping pong smash ace: count (0.4) + scores before each (0.3 each)."""

    RUBRIC = """\
Ground Truth (3 items):

1. Number of times Chinese player smashed and opponent couldn't touch the ball (0.4): \
2 times.
   - Exact (2): 0.4
   - Otherwise: 0.0

2. Score before the first such point, Chinese player first (0.3): 0:0.
   - Correct (0:0): 0.3
   - Wrong: 0.0

3. Score before the second such point, Chinese player first (0.3): 3:1.
   - Correct (3:1): 0.3
   - Wrong: 0.0

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
