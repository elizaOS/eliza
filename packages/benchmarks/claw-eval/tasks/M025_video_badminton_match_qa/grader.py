"""M025_video_badminton_match_qa grader — badminton match QA."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class VideoBadmintonMatchQAGrader(AbstractGrader, MultimodalGraderMixin):
    """Grade badminton match QA: 5 items, each 0.2 (last split 0.1+0.1)."""

    RUBRIC = """\
Ground Truth (5 items, each 0.2):

1. Teams (0.2): 郑思维/黄雅琼 vs 徐承宰/蔡侑玎.
2. Event (0.2): 羽毛球混合双打 (badminton mixed doubles).
3. Score (0.2): 郑思维/黄雅琼 19:18 徐承宰/蔡侑玎, score did not change throughout the video.
4. Scoring team (0.2): 徐承宰/蔡侑玎 scored. Must list both member names.
5. Red team introduction (0.2, split into 0.1 correct + 0.1 detailed):
   Red team = 郑思维/黄雅琼 (Chinese badminton mixed doubles pair).
   - 郑思维: born 1997, from Wenzhou Zhejiang, strong back-court attacker.
   - 黄雅琼: born 1995, from Hangzhou Zhejiang, excellent net play.
   - Achievements: multiple World Championship titles, long-time world #1.
   - Style: classic mixed doubles formation (woman front, man back).
   Content correctness (0.1): basic facts correct.
   Content detail (0.1): only awarded if correctness scored, must include biographical detail.

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
