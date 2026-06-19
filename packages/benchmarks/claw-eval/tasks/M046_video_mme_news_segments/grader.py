"""M046_video_mme_news_segments grader — count news segments and identify timestamps."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class VideoMme005Grader(AbstractGrader, MultimodalGraderMixin):
    """Grade news segment count and timestamp identification."""

    RUBRIC = """\
Question: Count the total number of distinct news segments that appear. \
For each segment, identify its start and end timestamp.

Ground-Truth Answer: 4 distinct news segments:
1st: 2:53 - 3:15  (173s - 195s)
2nd: 3:48 - 4:17  (228s - 257s)
3rd: 22:03 - 22:13  (1323s - 1333s)
4th: 23:08 - 23:13  (1388s - 1393s)

Scoring (total = 1.0):

Step 1 — Count score (0.2):
- Award 0.2 if the agent reports exactly 4 segments.
- Award 0.0 otherwise.

Step 2 — Per-segment IoU score (0.2 each, 4 segments = 0.8 total):
For each ground-truth segment, find the agent's reported segment that best overlaps with it, \
then compute IoU = intersection_duration / union_duration (both in seconds).
Award 0.2 × IoU for that segment. If the agent did not report a matching segment, IoU = 0.

Final score = count_score + sum of 4 segment IoU scores."""

    ANSWER_FILE = "/workspace/answer.txt"

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

        entry = (env_snapshot or {}).get(f"file:{self.ANSWER_FILE}", {})
        answer_text = (
            entry.get("content", "").strip()
            if entry.get("encoding") != "base64"
            else ""
        )

        if judge and answer_text:
            result = judge.evaluate(
                task_prompt=task.prompt.text,
                conversation=answer_text,
                actions_summary="",
                rubric=self.RUBRIC,
            )
            scores.completion = result.score if result else 0.0
        else:
            scores.completion = 0.0

        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
