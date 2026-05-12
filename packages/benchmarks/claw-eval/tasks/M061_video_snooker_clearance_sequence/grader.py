"""M061_video_snooker_clearance_sequence grader — snooker clearance ball sequence."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class VideoSnookerClearanceSequenceGrader(AbstractGrader, MultimodalGraderMixin):
    """Grade snooker clearance ball sequence using sequence similarity."""

    RUBRIC = """\
Ground Truth:

The correct clearance sequence (36 balls total) is:
Red Blue Red Blue Red Blue Red Pink Red Pink Red Pink Red Black \
Red Black Red Pink Red Black Red Black Red Black Red Pink Red Black \
Red Pink Yellow Green Brown Blue Pink Black

Scoring method:
Compare the agent's sequence against the ground truth using longest common \
subsequence (LCS) similarity.

- Count the total number of balls in the agent's answer.
- Compute the longest common subsequence between the agent's sequence and the \
ground truth sequence.
- acc = LCS_length / 36 (the ground truth length).
- score = max(0, 2*acc-1), which maps acc=0.5 to score=0, acc=1 to score=1, and acc<0.5 to negative scores that are floored at 0.
- If the agent lists no sequence or clearly wrong content, score 0.0.

Be lenient with minor color name variations (e.g., "red" vs "Red") \
as long as the color identity is clear.

Final score = score (0.0-1.0)."""

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
