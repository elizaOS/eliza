"""M045_video_mme_building_identification grader — identify 11th building + extract frame."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.graders.visual_grader import VisualGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class VideoMme004Grader(AbstractGrader, MultimodalGraderMixin, VisualGraderMixin):
    """Grade building answer (0.4) + extracted frame image (0.6).

    - text_score (0.4): 1.0 for correct name+height, 0.5 for correct name only, 0.0 otherwise.
    - image_score (0.6): file exists (0.1) + visual judge confirms frame shows Eiffel Tower (0.5).
    """

    ANSWER_FILE = "/workspace/answer.txt"
    OUTPUT_FILE = "/workspace/building_frame.png"

    TEXT_RUBRIC = """\
Question: What is the 11th building introduced in the video, and how tall is it as of March 2026?

Ground-Truth Answer: The building is the Eiffel Tower (埃菲尔铁塔), 330 meters tall as of March 2026.

Scoring:
- Score 1.0 if the agent correctly identifies the Eiffel Tower AND states the height as 330 meters \
(accept variations like "330m", "330 metres", etc.).
- Score 0.5 if the agent correctly identifies the Eiffel Tower but states the wrong height or omits it.
- Score 0.0 if the building is wrong, or the building is missing, \
or the agent only answers the height correctly but identifies the wrong building.
NOTE: Ignore whether any actions were taken. Judge the answer text only."""

    VISUAL_RUBRIC = """\
Evaluate this extracted video frame:

The frame should clearly show the Eiffel Tower (埃菲尔铁塔), \
which is the 11th building formally introduced in the video.

Scoring:
- Score 1.0 if the Eiffel Tower is clearly identifiable in the frame.
- Score 0.0 if the Eiffel Tower is not clearly identifiable, or the frame is unrelated."""

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

        # --- Text part (0.4): read answer from saved file ---
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
                    context="Extracted frame from the video, should show the Eiffel Tower.",
                )
                visual_score = result.score if result else 0.0
                image_score += 0.7 * visual_score

        scores.completion = round(0.2 * text_score + image_score, 2)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
