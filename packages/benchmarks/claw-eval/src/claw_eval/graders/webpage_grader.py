"""Base graders for dynamic webpage generation and image reproduction tasks.

All scoring is done via LLM Judge with vision — no rule-based fallbacks.
"""

from __future__ import annotations

from typing import Any

from .base import AbstractGrader
from .multimodal_common import MultimodalGraderMixin
from .visual_grader import VisualGraderMixin
from ..models.task import TaskDefinition
from ..models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class DynamicWebpageGrader(AbstractGrader, MultimodalGraderMixin, VisualGraderMixin):
    """Base grader for animated webpage tasks (A-class config + B-hard).

    Scoring:  VISUAL_WEIGHT  * visual_quality (LLM Judge)
            + PHYSICS_WEIGHT * animation_correctness (LLM Judge)

    Subclasses must define VISUAL_RUBRIC and PHYSICS_RUBRIC.
    """

    VISUAL_RUBRIC: str = ""
    PHYSICS_RUBRIC: str = ""
    VISUAL_WEIGHT: float = 0.75
    PHYSICS_WEIGHT: float = 0.25
    REFERENCE_IMAGE_PATH: str | None = None  # For B-hard tasks

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

        # --- Collect screenshots ---
        screenshots = self.collect_screenshots_from_snapshot(env_snapshot)

        if not screenshots:
            # No screenshots captured — the page was not produced or recording failed
            scores.completion = 0.0
            scores.robustness = self.compute_robustness(dispatches)
            scores.efficiency_turns = self._count_turns(messages)
            return scores

        # --- Reference images (for B-hard tasks) ---
        ref_images = self._collect_reference_images(env_snapshot)
        print(f"[grader] {task.task_id}: {len(screenshots)} screenshots, {len(ref_images)} reference images")

        # --- Visual quality (LLM Judge) ---
        visual_score = 0.0
        if judge and self.VISUAL_RUBRIC:
            result = self.judge_visual_similarity(
                judge,
                ref_images_b64=ref_images,
                gen_images_b64=screenshots,
                rubric=self.VISUAL_RUBRIC,
                context="Candidate screenshots of a generated webpage.",
            )
            if result:
                visual_score = result.score

        # --- Physics / animation correctness (LLM Judge) ---
        physics_score = 0.0
        if judge and self.PHYSICS_RUBRIC:
            result = self.judge_visual_similarity(
                judge,
                ref_images_b64=ref_images,
                gen_images_b64=screenshots,
                rubric=self.PHYSICS_RUBRIC,
                context="Sequential frames captured over 5 seconds of a generated animation.",
            )
            if result:
                physics_score = result.score

        completion = (
            self.VISUAL_WEIGHT * visual_score
            + self.PHYSICS_WEIGHT * physics_score
        )
        scores.completion = round(min(completion, 1.0), 2)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = self._count_turns(messages)
        print(f"[grader] {task.task_id}: visual={visual_score:.2f} physics={physics_score:.2f} "
              f"→ C={scores.completion} (w={self.VISUAL_WEIGHT}/{self.PHYSICS_WEIGHT})")
        return scores

    def _collect_reference_images(self, env_snapshot: dict | None) -> list[str]:
        if not self.REFERENCE_IMAGE_PATH or not env_snapshot:
            return []
        key = f"local_file:{self.REFERENCE_IMAGE_PATH}"
        entry = env_snapshot.get(key, {})
        if entry.get("encoding") == "base64" and entry.get("content"):
            return [entry["content"]]
        return []

    @staticmethod
    def _count_turns(messages: list[TraceMessage]) -> int:
        return len([m for m in messages if m.message.role == "assistant"])


class ImageReproductionGrader(AbstractGrader, MultimodalGraderMixin, VisualGraderMixin):
    """Base grader for static image reproduction tasks (B-easy).

    Scoring: 100% visual fidelity via LLM Judge comparing against reference.

    Subclasses must define VISUAL_RUBRIC and REFERENCE_IMAGE_PATH.
    """

    VISUAL_RUBRIC: str = ""
    REFERENCE_IMAGE_PATH: str = ""

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

        # --- Collect screenshots ---
        screenshots = self.collect_screenshots_from_snapshot(env_snapshot)

        if not screenshots:
            scores.completion = 0.0
            scores.robustness = self.compute_robustness(dispatches)
            scores.efficiency_turns = self._count_turns(messages)
            return scores

        # --- Reference image ---
        ref_images = self._collect_reference_images(env_snapshot)
        print(f"[grader] {task.task_id}: {len(screenshots)} screenshots, {len(ref_images)} reference images")

        # --- Visual fidelity (LLM Judge) ---
        # Static pages: send only 1 screenshot (no animation to capture)
        visual_score = 0.0
        if judge and self.VISUAL_RUBRIC:
            result = self.judge_visual_similarity(
                judge,
                ref_images_b64=ref_images,
                gen_images_b64=screenshots[:1],
                rubric=self.VISUAL_RUBRIC,
                context="Compare the candidate webpage screenshot against the original reference image. Focus on content accuracy, not just visual similarity.",
            )
            if result:
                visual_score = result.score

        scores.completion = round(min(visual_score, 1.0), 2)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = self._count_turns(messages)
        print(f"[grader] {task.task_id}: visual={visual_score:.2f} → C={scores.completion}")
        return scores

    def _collect_reference_images(self, env_snapshot: dict | None) -> list[str]:
        if not self.REFERENCE_IMAGE_PATH or not env_snapshot:
            return []
        key = f"local_file:{self.REFERENCE_IMAGE_PATH}"
        entry = env_snapshot.get(key, {})
        if entry.get("encoding") == "base64" and entry.get("content"):
            return [entry["content"]]
        return []

    @staticmethod
    def _count_turns(messages: list[TraceMessage]) -> int:
        return len([m for m in messages if m.message.role == "assistant"])
