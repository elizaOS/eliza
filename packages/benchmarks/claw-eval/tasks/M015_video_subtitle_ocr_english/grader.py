"""M015_video_subtitle_ocr_english grader — English word extraction from video."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class VideoSubtitleOcrEnglishGrader(AbstractGrader, MultimodalGraderMixin):
    """Grade English word extraction from video segment (0:25–0:30).

    No output file — grader reads the final assistant text and sends it
    to the LLM judge with the ground-truth rubric.
    """

    RUBRIC = """\
Ground Truth: "Two sizes. Two new blacks. Black black. And really black. \
Jet black. Black so black it's black to the core."

Note: Ignore punctuation and case.
- 1.0: All words appear exactly (no missing or extra words), and in the correct order.
- 0.8: 2 or fewer word errors (including missing, extra, or incorrect words).
- 0.5: 5 or fewer word errors.
- 0.0: More than 5 word errors.

Evaluate the agent's final answer against the ground truth using the criteria above.
Output a score between 0.0 and 1.0."""

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
