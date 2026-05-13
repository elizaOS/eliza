"""M039_video_lvb_machine_dog grader — machine operation interval + cropped dog frame."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.graders.visual_grader import VisualGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class Lvb002Grader(AbstractGrader, MultimodalGraderMixin, VisualGraderMixin):
    """Grade time interval answer (0.4) + cropped dog frame image (0.6).

    - text_score (0.4): IoU of predicted interval vs ground-truth 5:03–5:05, computed by LLM.
    - image_score (0.6): file exists (0.1) + visual judge confirms frame shows the dog (0.5).
    """

    TIMESTAMP_FILE = "/workspace/timestamp.txt"
    OUTPUT_FILE = "/workspace/cropped_frame.png"

    TEXT_RUBRIC = """\
The following text was saved by an agent as the answer to this question:
"During which time interval is a person wearing jeans and a blue shirt operating a machine \
next to a white wall?"

The ground-truth answer is: start = 303 seconds (5:03), end = 305 seconds (5:05).

Your task:
1. Parse the predicted start and end times from the text below, converting any timestamp \
format (e.g. "5:03 - 5:05", "from 5 minutes 3 seconds to 5 minutes 5 seconds", etc.) \
into seconds.
2. Compute IoU = intersection / union of the predicted interval and the ground-truth interval \
[303, 305].
3. Return the IoU value as your score (a float between 0.0 and 1.0). \
If no valid interval can be parsed, return 0.0."""

    VISUAL_RUBRIC = """\
Evaluate this cropped video frame:

The frame should show a dog passing by from the right side of a machine next to a white wall. \
The dog should be the main subject, clearly visible and centered in the crop. \
The scene occurs around 5:03–5:05 in the video.

Scoring:
- Score 1.0 if a dog is clearly visible and centered as the main subject of the crop.
- Score 0.5 if a dog is visible but the crop is not well-centered on it, or it is partially \
cut off.
- Score 0.0 if no dog is visible, the frame is from the wrong scene, or the file is \
empty/corrupt."""

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

        # --- Text part (0.4): LLM parses predicted interval and computes IoU vs 5:03–5:05 ---
        text_score = 0.0
        ts_entry = (env_snapshot or {}).get(f"file:{self.TIMESTAMP_FILE}", {})
        timestamp_text = (
            ts_entry.get("content", "").strip()
            if ts_entry.get("encoding") != "base64"
            else ""
        )
        if judge and timestamp_text:
            result = judge.evaluate(
                task_prompt=task.prompt.text,
                conversation=timestamp_text,
                actions_summary="",
                rubric=self.TEXT_RUBRIC,
            )
            text_score = result.score if result else 0.0

        # --- Image part (0.6): file exists (0.1) + visual judge (0.5) ---
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
                    context=(
                        "Cropped frame from ~5:03–5:05 showing a dog passing by the right "
                        "side of the machine, centered as the main subject."
                    ),
                )
                visual_score = result.score if result else 0.0
                image_score += 0.5 * visual_score

        scores.completion = round(0.4 * text_score + image_score, 2)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
