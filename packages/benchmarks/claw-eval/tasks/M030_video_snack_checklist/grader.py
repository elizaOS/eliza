"""M030_video_snack_checklist grader — vlog snack checklist image."""

from __future__ import annotations

from typing import Any

from claw_eval.graders.base import AbstractGrader
from claw_eval.graders.multimodal_common import MultimodalGraderMixin
from claw_eval.graders.visual_grader import VisualGraderMixin
from claw_eval.models.task import TaskDefinition
from claw_eval.models.trace import DimensionScores, MediaLoad, ToolDispatch, TraceMessage


class VideoSnackChecklistGrader(AbstractGrader, MultimodalGraderMixin, VisualGraderMixin):
    """Grade snack checklist image: file(0.1) + visual(0.9).

    Single visual judge call evaluates recall, label matching, and style.
    """

    OUTPUT_FILE = "/workspace/snack_checklist.jpg"

    VISUAL_RUBRIC = """\
Evaluate this snack checklist image from a vlog:

Ground truth snacks (6 total):
1. Rice Cracker with Pork Floss
2. Mango Jelly
3. Mango Flavour Soft Candy
4. 榴莲软糖 (Durian Soft Candy)
5. Crispy Thai Coconut Milk
6. Thai Coconut Caramel

Evaluation criteria:

1. Snack image recall (0.35):
   Check how many of the 6 snacks have a clear photo/screenshot in the image.
   Score = (number found) / 6 * 0.35.

2. Label matching (0.35):
   Check how many snacks have correct text labels (name annotations) visible \
outside the product images. English preferred, Chinese acceptable for 榴莲软糖.
   Score = (number correctly labeled) / 6 * 0.35.

3. Checklist style (0.3):
   - Does it look like a food/snack checklist or collection card? (0.15)
   - Is the layout organized with clear grid/cards? (0.15)

Score 0.0-1.0 based on weighted sum of all criteria."""

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

        # Check file exists
        file_exists = self.check_file_exists(env_snapshot, self.OUTPUT_FILE)
        if not file_exists:
            scores.completion = 0.0
            scores.robustness = self.compute_robustness(dispatches)
            return scores

        # Extract image
        jpg_entry = (env_snapshot or {}).get(f"file:{self.OUTPUT_FILE}", {})
        jpg_b64 = (
            jpg_entry.get("content", "")
            if jpg_entry.get("encoding") == "base64"
            else ""
        )
        if not jpg_b64:
            scores.completion = 0.1  # file exists but can't read
            scores.robustness = self.compute_robustness(dispatches)
            return scores

        visual_score = 0.0
        if judge and hasattr(judge, "evaluate_visual"):
            result = judge.evaluate_visual(
                rubric=self.VISUAL_RUBRIC,
                reference_images_b64=[],
                candidate_images_b64=[jpg_b64],
                context="Evaluate a snack checklist image created from a vlog video.",
            )
            visual_score = result.score if result else 0.0

        scores.completion = round(0.1 + 0.9 * visual_score, 2)
        scores.completion = min(scores.completion, 1.0)
        scores.robustness = self.compute_robustness(dispatches)
        scores.efficiency_turns = len(
            [m for m in messages if m.message.role == "assistant"]
        )
        return scores
