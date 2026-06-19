"""M040_video_lvb_vehicle_identification grader — identify non-train vehicle and extract centered frame."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.graders.visual_grader import VisualGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class Lvb003Grader(AbstractGrader, MultimodalGraderMixin, VisualGraderMixin):
    """Grade extracted vehicle frame image (1.0).

    - image_score (1.0): file exists (0.1) + visual judge confirms frame shows airplane centered (0.9).
    """

    OUTPUT_FILE = "/workspace/vehicle_frame.png"

    VISUAL_RUBRIC = """\
Evaluate this extracted video frame:

The scene shows soldiers wearing white shirts, grey pants, and green hats, \
carrying guns and fighting people on a train. \
The frame should clearly show an airplane (飞机).

Scoring:
- Score 1.0 if an airplane is clearly identifiable and is the central subject of the frame.
- Score 0.5 if an airplane is visible but not clearly centered or prominent.
- Score 0.0 if no airplane is visible, or the frame is unrelated to the described scene."""

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

        # --- Image part (1.0): file exists (0.1) + visual judge (0.9) ---
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
                    context="Extracted frame from the video, should show an airplane centered in the scene.",
                )
                visual_score = result.score if result else 0.0
                image_score += 0.9 * visual_score

        scores.completion = round(image_score, 2)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
