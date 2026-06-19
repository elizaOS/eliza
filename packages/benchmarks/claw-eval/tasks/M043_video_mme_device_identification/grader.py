"""M043_video_mme_device_identification grader — identify device + extract frame."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.graders.visual_grader import VisualGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class VideoMme002Grader(AbstractGrader, MultimodalGraderMixin, VisualGraderMixin):
    """Grade device identification (0.2) + extracted frame image (0.8).

    - text_score (0.2): agent correctly identifies Quest 3 as the device.
    - image_score (0.8): file exists (0.1) + visual judge confirms frame shows device (0.7).
    """

    ANSWER_FILE = "/workspace/answer.txt"
    OUTPUT_FILE = "/workspace/device_frame.png"

    TEXT_RUBRIC = """\
Question: What device is used to shoot vertical short videos in the video?

Ground-Truth Answer: Quest 3 (a mixed reality headset made by Meta).

Scoring:
- Score 1.0 if the agent correctly identifies the device as "Quest 3" \
(accept variations like "Meta Quest 3", "Quest3", etc.).
- Score 0.0 if the answer is wrong or missing.
NOTE: Ignore whether any actions were taken. Judge the answer text only."""

    VISUAL_RUBRIC = """\
Evaluate this extracted video frame:

The frame should clearly show the Quest 3 mixed reality headset \
(a Meta VR/MR headset device).

Scoring:
- Score 1.0 if the Quest 3 headset is clearly visible in the frame.
- Score 0.5 if a VR/MR headset is visible but it is unclear whether it is Quest 3 specifically.
- Score 0.0 if the device is not visible or the frame is unrelated."""

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

        # --- Text part (0.5): read answer from saved file ---
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

        # --- Image part (0.5): file exists (0.1) + visual judge (0.4) ---
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
                    context="Extracted frame from the video, should show the Quest 3 device.",
                )
                visual_score = result.score if result else 0.0
                image_score += 0.7 * visual_score

        scores.completion = round(0.2 * text_score + image_score, 2)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
