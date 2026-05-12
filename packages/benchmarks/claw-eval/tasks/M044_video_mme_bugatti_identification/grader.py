"""M044_video_mme_bugatti_identification grader — identify Bugatti model + extract frame."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.graders.visual_grader import VisualGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class VideoMme003Grader(AbstractGrader, MultimodalGraderMixin, VisualGraderMixin):
    """Grade Bugatti model identification (0.2) + extracted frame image (0.8).

    - text_score (0.2): agent correctly identifies Bugatti Type 44.
    - image_score (0.8): file exists (0.1) + visual judge confirms frame shows Type 44 (0.7).
    """

    ANSWER_FILE = "/workspace/answer.txt"
    OUTPUT_FILE = "/workspace/bugatti_frame.png"

    TEXT_RUBRIC = """\
Question: Which Bugatti model was historically the first to feature a closed automobile roof?

Ground-Truth Answer: Bugatti Type 44.

Scoring:
- Score 1.0 if the answer correctly identifies the model as "Type 44" \
(accept variations like "Bugatti Type 44", "Type-44", etc.).
- Score 0.0 if the answer is wrong or missing.
- NOTE: Ignore whether any actions were taken. Judge the answer text only."""

    VISUAL_RUBRIC = """\
Evaluate this extracted video frame:

The frame should clearly show the Bugatti Type 44, which features a closed automobile roof.

Scoring:
- Score 1.0 if the text "Type 44" (or "Type44") is visibly present in the frame \
(e.g., as a label, caption, or on-screen text), OR if the Bugatti Type 44 is \
unmistakably identifiable by its visual features.
- Score 0.0 if the text "Type 44" is not visible AND the car is not clearly identifiable, \
or the frame is unrelated.

IMPORTANT: First check explicitly whether the text "Type 44" appears anywhere in the frame."""

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

        # --- Text part (0.2): read answer from saved file ---
        text_score = 0.0
        ans_entry = (env_snapshot or {}).get(f"file:{self.ANSWER_FILE}", {})
        answer_text = (
            ans_entry.get("content", "").strip()
            if ans_entry.get("encoding") != "base64"
            else ""
        )
        if judge and answer_text:
            result = judge.evaluate(
                task_prompt=task.prompt.text,
                conversation=answer_text,
                actions_summary="",
                rubric=self.TEXT_RUBRIC,
            )
            text_score = result.score if result else 0.0

        # --- Image part (0.8): file exists (0.1) + visual judge (0.7) ---
        image_score = 0.0
        file_exists = self.check_file_exists(env_snapshot, self.OUTPUT_FILE)
        if file_exists:
            image_score += 0.1

            png_entry = (env_snapshot or {}).get(f"file:{self.OUTPUT_FILE}", {})
            png_b64 = (
                png_entry.get("content", "")
                if png_entry.get("encoding") == "base64"
                else ""
            )
            if png_b64 and judge and hasattr(judge, "evaluate_visual"):
                result = judge.evaluate_visual(
                    rubric=self.VISUAL_RUBRIC,
                    reference_images_b64=[],
                    candidate_images_b64=[png_b64],
                    context="Extracted frame from the video, should show the Bugatti Type 44.",
                )
                visual_score = result.score if result else 0.0
                image_score += 0.7 * visual_score

        scores.completion = round(0.2 * text_score + image_score, 2)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
