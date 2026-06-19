"""M034_video_tennis_shotlog_qa grader — Murray vs Federer shot-by-shot analysis."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class VideoTennisShotlogQAGrader(AbstractGrader, MultimodalGraderMixin):
    """Grade tennis shot log QA: server(0.1) + shot log(0.5) + count(0.3) + winner(0.1)."""

    RUBRIC = """\
Ground Truth (point at Set 0:1, Game 4:5, Point 0:15):

1. Server (0.1): Andy Murray is serving. Score 0.1 if correct, 0 otherwise.

2. Shot-by-shot log (0.5):
   Ground truth rally sequence (after the serve):
   - Roger Federer - backhand
   - Andy Murray - forehand
   - Roger Federer - backhand
   - Andy Murray - forehand
   - Roger Federer - forehand

   Scoring breakdown:
   - Player sequence correctness (0.25): The sequence of player names hitting \
the ball must be correct: Federer, Murray, Federer, Murray, Federer. \
If the player sequence is wrong, the entire shot log scores 0.
   - Stroke type correctness (0.25): For each of the 5 return shots, \
score 0.05 if the stroke type (forehand/backhand) is correct. \
Only scored if the player sequence is correct.

3. Total shot count (0.3): 6 shots (including the serve). \
Score 0.3 if exactly correct, 0 otherwise.

4. Point winner (0.1): Roger Federer wins the point. \
Score 0.1 if correct, 0 otherwise.

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
