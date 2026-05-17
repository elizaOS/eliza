"""Grader for M092_video_movie_title_localization: Movie Title Card Localization and Frame Extraction.

Task: Find the film title on screen, extract frame, report Chinese and English names.

GT: Chinese title = 遍地狼烟, English title = COLD STEEL
    Title appears at ~00:45-00:47, bullets in slow motion on dark reflective surface.
    Reference image: fixtures/gt.png

Scoring (total = 1.0):
  - 0.4: Chinese title correct (遍地狼烟)
  - 0.4: English title correct (COLD STEEL)
  - 0.1: title_frame.png exists
  - 0.1: title_frame.png visual match against fixtures/gt.png
"""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.graders.visual_grader import VisualGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


ANSWER_FILE = "/workspace/answer.txt"
IMAGE_FILE = "/workspace/title_frame.png"
GT_IMAGE = "/workspace/fixtures/gt.png"

CHINESE_TITLE_RUBRIC = """\
You are evaluating whether the agent correctly identified the Chinese film title.

The correct Chinese film title is: 遍地狼烟

The agent's answer.txt content is provided below. Check if it contains the \
correct Chinese title.

Scoring:
- 1.0: The answer contains "遍地狼烟" (exact match).
- 0.0: The answer does not contain "遍地狼烟" or gives a wrong title."""

ENGLISH_TITLE_RUBRIC = """\
You are evaluating whether the agent correctly identified the English film title.

The correct English film title is: COLD STEEL

The agent's answer.txt content is provided below. Check if it contains the \
correct English title.

Scoring:
- 1.0: The answer contains "COLD STEEL" (case-insensitive match).
- 0.0: The answer does not contain "COLD STEEL" or gives a wrong English title."""

VISUAL_MATCH_RUBRIC = """\
You are comparing two images from a war movie.

The REFERENCE image (first) shows the ground-truth title card frame: Chinese \
title "遍地狼烟" displayed on screen with sniper rifle bullets falling in slow \
motion onto a dark reflective surface.

The CANDIDATE image (second) is the agent's extracted frame.

Determine whether the candidate shows the same title card scene.

Scoring:
- 1.0: Same scene — title text "遍地狼烟" is clearly visible in a matching composition
- 0.5: Similar scene or partially matching (title partially visible, or same \
moment but different framing)
- 0.0: Different scene entirely, or no title text visible"""


class Grader(AbstractGrader, MultimodalGraderMixin, VisualGraderMixin):
    """Title card localization grader: Chinese name + English name + frame."""

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
        # 1. Chinese title (0.4)
        # ------------------------------------------------------------------
        cn_score = 0.0
        answer_entry = snapshot.get(f"file:{ANSWER_FILE}", {})
        answer_text = (
            answer_entry.get("content", "").strip()
            if answer_entry.get("encoding") != "base64"
            else ""
        )

        if answer_text and judge:
            result = judge.evaluate(
                task_prompt=task.prompt.text,
                conversation=f"Agent's answer.txt:\n{answer_text}",
                actions_summary="",
                rubric=CHINESE_TITLE_RUBRIC,
            )
            cn_score = result.score if result else 0.0

        total += 0.4 * cn_score

        # ------------------------------------------------------------------
        # 2. English title (0.4)
        # ------------------------------------------------------------------
        en_score = 0.0
        if answer_text and judge:
            result = judge.evaluate(
                task_prompt=task.prompt.text,
                conversation=f"Agent's answer.txt:\n{answer_text}",
                actions_summary="",
                rubric=ENGLISH_TITLE_RUBRIC,
            )
            en_score = result.score if result else 0.0

        total += 0.4 * en_score

        # ------------------------------------------------------------------
        # 3. Image existence (0.1)
        # ------------------------------------------------------------------
        image_exists = self.check_file_exists(snapshot, IMAGE_FILE)
        if image_exists:
            total += 0.1

        # ------------------------------------------------------------------
        # 4. Image visual match against GT (0.1)
        # ------------------------------------------------------------------
        visual_score = 0.0
        if image_exists and judge:
            img_entry = snapshot.get(f"file:{IMAGE_FILE}", {})
            img_b64 = (
                img_entry.get("content", "")
                if img_entry.get("encoding") == "base64"
                else ""
            )

            gt_entry = snapshot.get(f"file:{GT_IMAGE}", {})
            gt_b64 = (
                gt_entry.get("content", "")
                if gt_entry.get("encoding") == "base64"
                else ""
            )

            if img_b64 and gt_b64:
                result = self.judge_visual_similarity(
                    judge,
                    ref_images_b64=[gt_b64],
                    gen_images_b64=[img_b64],
                    rubric=VISUAL_MATCH_RUBRIC,
                    context="Comparing agent's title frame against GT title card from the movie.",
                )
                if result:
                    visual_score = result.score

        total += 0.1 * visual_score

        # ------------------------------------------------------------------
        # Final
        # ------------------------------------------------------------------
        scores.completion = round(min(total, 1.0), 3)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )

        print(
            f"[grader] {task.task_id}: cn={cn_score:.2f} en={en_score:.2f} "
            f"img_exists={image_exists} visual={visual_score:.2f} "
            f"-> completion={scores.completion}"
        )
        return scores
