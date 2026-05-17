"""Grader for M089_video_movie_scene_meme: Movie Scene Localization - Driver Meme Creation.

Task: Find the RV driver's shocked expression at ~00:24, extract a face close-up
frame, add "wow" text to create a meme, save as /workspace/meme.png.

GT reference image: fixtures/gt.png (the driver's shocked face)

Scoring (total = 1.0):
  - 0.2: meme.png file exists
  - 0.4: face match — the person in meme.png matches the GT driver (visual comparison)
  - 0.4: meme quality — text "wow" is visible, meme style formatting
"""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.graders.visual_grader import VisualGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


MEME_PATH = "/workspace/meme.png"
GT_IMAGE_PATH = "/workspace/fixtures/gt.png"

FACE_MATCH_RUBRIC = """\
You are comparing two images from a movie clip.

The REFERENCE image (first) shows the ground-truth: an RV driver with a shocked \
expression. He is a middle-aged man with a hat and beard, wearing a light blue \
shirt and grayish-green vest.

The CANDIDATE image (second) is the agent's output meme. Ignore any text overlay \
or meme formatting — focus ONLY on whether the person shown is the SAME person \
as in the reference image.

Scoring:
- 1.0: Clearly the same person (the shocked RV driver)
- 0.5: Likely the same person but image quality is poor, angle is very different, \
or face is partially obscured
- 0.0: Different person, no face visible, or image is empty/corrupt"""

MEME_QUALITY_RUBRIC = """\
You are evaluating a meme image created from a movie frame.

The task required the agent to:
1. Extract the RV driver's shocked face as a close-up
2. Add the text "wow" to create a meme-style image

Evaluate the candidate image:
1. Is the text "wow" (or "WOW") visible on the image?
2. Is the image styled as a meme (text overlay on a face/reaction image)?
3. Is the driver's shocked expression clearly visible?

Scoring:
- 1.0: "wow" text is clearly visible, meme-style formatting, shocked face is clear
- 0.7: "wow" text is present and face is visible, but formatting is basic
- 0.4: Either "wow" text is missing but face is a good close-up, or text is present \
but face is too small / not clearly shocked
- 0.0: No text, no clear face, or image is unrelated"""


class Grader(AbstractGrader, MultimodalGraderMixin, VisualGraderMixin):
    """Driver meme creation grader: file existence + face match + meme quality."""

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
        snapshot = env_snapshot or {}
        total = 0.0

        # ------------------------------------------------------------------
        # 1. File existence (0.2)
        # ------------------------------------------------------------------
        file_ok = self.check_file_exists(snapshot, MEME_PATH)
        if file_ok:
            total += 0.2
        else:
            scores.completion = 0.0
            scores.robustness = self.compute_robustness(dispatches)
            scores.efficiency_turns = len(
                [m for m in messages if m.message.role == "assistant"]
            )
            return scores

        # Get meme image base64
        meme_entry = snapshot.get(f"file:{MEME_PATH}", {})
        meme_b64 = (
            meme_entry.get("content", "")
            if meme_entry.get("encoding") == "base64"
            else ""
        )

        # Get GT image base64
        gt_entry = snapshot.get(f"file:{GT_IMAGE_PATH}", {})
        gt_b64 = (
            gt_entry.get("content", "")
            if gt_entry.get("encoding") == "base64"
            else ""
        )

        # ------------------------------------------------------------------
        # 2. Face match against GT (0.4)
        # ------------------------------------------------------------------
        face_score = 0.0
        if meme_b64 and gt_b64 and judge:
            result = self.judge_visual_similarity(
                judge,
                ref_images_b64=[gt_b64],
                gen_images_b64=[meme_b64],
                rubric=FACE_MATCH_RUBRIC,
                context="Comparing agent's meme against GT driver face from the movie clip.",
            )
            if result:
                face_score = result.score

        total += 0.4 * face_score

        # ------------------------------------------------------------------
        # 3. Meme quality — "wow" text + formatting (0.4)
        # ------------------------------------------------------------------
        meme_score = 0.0
        if meme_b64 and judge:
            result = self.judge_visual_similarity(
                judge,
                ref_images_b64=[],
                gen_images_b64=[meme_b64],
                rubric=MEME_QUALITY_RUBRIC,
                context="Evaluating meme quality: text overlay and facial expression visibility.",
            )
            if result:
                meme_score = result.score

        total += 0.4 * meme_score

        # ------------------------------------------------------------------
        # Final
        # ------------------------------------------------------------------
        scores.completion = round(min(total, 1.0), 3)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )

        print(
            f"[grader] {task.task_id}: file_ok={file_ok} "
            f"face={face_score:.2f} meme={meme_score:.2f} "
            f"-> completion={scores.completion}"
        )
        return scores
