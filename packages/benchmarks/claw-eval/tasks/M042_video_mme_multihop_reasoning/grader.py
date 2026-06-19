"""M042_video_mme_multihop_reasoning grader — multi-hop video QA."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class VideoMmeMultihopGrader(AbstractGrader, MultimodalGraderMixin):
    """Grade multi-hop video reasoning QA task."""

    RUBRIC = """\
Question: On what date did the individual in the video leave a place that Simon thought was very important to him?

Ground-Truth Answer: June 9, 2021

Scoring:
- Score 1.0 if the agent's answer matches "June 9, 2021" exactly or in an equivalent format \
(e.g., "2021-06-09", "9 June 2021", "June 9th, 2021").
- Score 0.0 if the answer is wrong, incomplete, missing, or the agent fails to answer the question.
NOTE: Ignore whether any actions were taken. Judge the answer text only."""

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
